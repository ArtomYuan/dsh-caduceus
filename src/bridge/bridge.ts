/**
 * The surface orchestrator.
 *
 * Inbound Feishu messages are delivered into a per-topic dsh session and the
 * dsh `session/event` stream is rendered back into the chat:
 * - a throttled "process" card per turn (patched in place), and a separate
 *   "status" card per topic (design doc §6 L3′);
 * - the final answer is always a NEW message, never an edit of the progress
 *   card (design doc §5 / A7);
 * - the same scope is processed serially; different scopes run in parallel;
 * - busy turns honor the configured busy mode (`queue` / `steer` / `interrupt`).
 *
 * Everything external (transport, agents, title service, command registry) is
 * injected, so the unit tests run against fakes with no dsh runtime and no
 * Feishu credentials.
 *
 * @module @artomyuan/dsh-caduceus/bridge/bridge
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { planSlashLine, type OwnedCommand } from '../commands/dispatch.js';
import { helpText } from '../commands/parse.js';
import { silentLogger, type LoggerLike } from '../logger.js';
import { progressCard, statusCard } from '../render/cards.js';
import { CardStream, systemClock } from '../render/stream.js';
import type { CardChannel, Clock } from '../render/stream.js';
import { truncateCardContent } from '../render/truncate.js';
import { mintSessionId, scopeKey, SCOPE_KEY_SEPARATOR, type SessionStore } from '../session-key.js';
import {
  StatusTracker,
  shouldNotifyTerminal,
  statusCardLines,
  statusLabel,
  statusTemplate,
  statusText,
  terminalNotice,
  type StatusEventLike,
  type StatusSnapshot,
} from '../status.js';
import type { ChatType, FeishuCard, InboundMessage, Transport } from '../transport/types.js';
import { ScopeQueue } from './scope-queue.js';
import type { AgentLike, AgentsLike, BridgeConfig, BridgeOptions, SessionTitleLike } from './types.js';

/** Final-answer text cap from the design doc (§6 L3: 150 KB). */
const FINAL_TEXT_MAX_BYTES = 150 * 1024;

interface ScopeState {
  readonly key: string;
  readonly chatId: string;
  readonly chatType: ChatType;
  readonly threadId?: string;
  lastInboundMessageId?: string;
  sessionId?: string;
  previousSessionId?: string;
  /** Unix epoch ms of the previous session's last known activity. */
  previousSessionAt?: number;
  /** Set by `/new`: the next resolution must create, not resume. */
  pendingCreate: boolean;
  running: boolean;
  readonly status: StatusTracker;
  progress?: CardStream;
  statusStream?: CardStream;
  lastOutput: string;
  /** Latest session title (from a `session/title` event or `/rename`). */
  title?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** UTC `HH:MM:SSZ` label used for diagnostics. */
function clockLabel(ms: number): string {
  const date = new Date(ms);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}Z`;
}

/** Human relative time for `/sessions` (e.g. `刚刚`, `5 分钟前`, `2 小时前`). */
function relativeTime(ms: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** Extract the assistant's text from one `assistant/message` payload. */
export function assistantTextFromEvent(data: unknown): string {
  const record = data as { message?: { content?: unknown } } | undefined;
  const content = record?.message?.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text);
  }
  return parts.join('\n');
}

/** Extract the raw `turn/end` reason kind. */
export function turnEndReasonKind(data: unknown): string | undefined {
  const record = data as { reason?: { kind?: unknown } } | undefined;
  return typeof record?.reason?.kind === 'string' ? record.reason.kind : undefined;
}

/** Extract the accepted title from a `session/title` event payload. */
export function titleFromEvent(data: unknown): string | undefined {
  const record = data as { title?: unknown } | undefined;
  return typeof record?.title === 'string' && record.title.trim().length > 0
    ? record.title
    : undefined;
}

/** The bridge. Construct one per gateway entry. */
export class Bridge {
  readonly #options: BridgeOptions;
  readonly #transport: Transport;
  readonly #sessionMap: SessionStore;
  readonly #agents: AgentsLike;
  readonly #config: BridgeConfig;
  readonly #logger: LoggerLike;
  readonly #clock: Clock;
  readonly #now: () => number;
  readonly #mint: () => string;
  readonly #sessionTitle: SessionTitleLike | undefined;
  readonly #queue = new ScopeQueue();
  readonly #states = new Map<string, ScopeState>();
  readonly #scopeBySession = new Map<string, string>();

  constructor(options: BridgeOptions) {
    this.#options = options;
    this.#transport = options.transport;
    this.#sessionMap = options.sessionMap;
    this.#agents = options.agents;
    this.#config = options.config;
    this.#logger = options.logger ?? silentLogger();
    this.#clock = options.clock ?? systemClock;
    this.#now = options.now ?? (() => this.#clock.now());
    this.#mint = options.mintSessionId ?? mintSessionId;
    this.#sessionTitle = options.sessionTitle;
    if (!this.#sessionMap.isLoaded) this.#sessionMap.load();
    for (const key of this.#sessionMap.keys()) {
      const sessionId = this.#sessionMap.get(key);
      if (sessionId !== undefined) this.#scopeBySession.set(sessionId, key);
    }
  }

  /** True when a session id belongs to a scope this bridge renders. */
  ownsSession(sessionId: string): boolean {
    return this.#scopeBySession.has(sessionId);
  }

  /** Process one inbound message (serialized per scope). */
  async handleInbound(message: InboundMessage): Promise<void> {
    if (!this.#allowed(message)) {
      this.#logger.debug(`ignoring message from non-allowed chat/user (${message.chatId})`);
      return;
    }
    if (!this.#accepts(message)) return;
    if (message.text.trim().length === 0) return;
    await this.#queue.run(
      scopeKey(
        message.chatType,
        message.chatId,
        message.threadId,
        message.senderOpenId,
        this.#config.groupSessionsPerUser,
      ),
      () => this.#processInbound(message),
    );
  }

  /** Feed one dsh session event into the render/status layer. */
  async handleSessionEvent(
    session: { readonly id: string },
    event: StatusEventLike,
  ): Promise<void> {
    const key = this.#scopeBySession.get(String(session.id));
    if (key === undefined) return;
    const state = this.#states.get(key);
    if (state === undefined) return;

    state.status.apply(event);

    switch (event.type) {
      case 'turn/start': {
        state.running = true;
        state.lastOutput = '';
        state.progress?.dispose();
        state.progress = this.#makeCardStream(state);
        if (state.statusStream === undefined) state.statusStream = this.#makeCardStream(state);
        await this.#renderProgress(state);
        await this.#renderStatus(state);
        break;
      }
      case 'step/start':
      case 'step/end':
      case 'tool/call':
      case 'tool/result': {
        await this.#renderProgress(state);
        await this.#renderStatus(state);
        break;
      }
      case 'assistant/message': {
        const text = assistantTextFromEvent(event.data);
        if (text.length > 0) state.lastOutput = text;
        await this.#renderProgress(state);
        break;
      }
      case 'turn/end': {
        await this.#settleTurn(state, event);
        break;
      }
      case 'session/title': {
        const title = titleFromEvent(event.data) ?? this.#titleOfSession(state);
        if (title !== undefined) state.title = title;
        // Re-render the EXISTING status card in place (throttled); never create
        // a new status message just because the title arrived late.
        if (state.statusStream?.messageId !== undefined) await this.#renderStatus(state);
        break;
      }
      default:
        // Informational events only refresh the tracker.
        break;
    }
  }

  async #processInbound(message: InboundMessage): Promise<void> {
    const state = this.#stateFor(message);
    state.lastInboundMessageId = message.messageId;
    const text = message.text.trim();
    if (text.startsWith('/')) {
      await this.#handleSlash(state, message.text);
      return;
    }
    await this.#deliverTurn(state, message.text);
  }

  async #handleSlash(state: ScopeState, raw: string): Promise<void> {
    const plan = planSlashLine(raw);
    if (plan.kind === 'denied') {
      await this.#replyText(state, `/${plan.name} 仅 Web 可执行，飞书里不转发。`);
      return;
    }
    if (plan.kind === 'owned') {
      await this.#runOwned(state, plan.command);
      return;
    }

    const resolved = await this.#tryResolve(state);
    if (resolved === undefined) {
      await this.#replyText(state, '会话不可用，无法执行该命令。');
      return;
    }
    const result = await this.#options.runHarnessCommand?.(resolved.agent, raw);
    if (result !== undefined) {
      await this.#replyText(
        state,
        result.text.length > 0 ? result.text : `/${plan.name || '命令'} 已执行。`,
      );
      return;
    }
    await this.#replyText(state, `未知命令 ${raw}。输入 /help 查看本外壳支持的命令。`);
  }

  async #runOwned(state: ScopeState, command: OwnedCommand): Promise<void> {
    switch (command.kind) {
      case 'new': {
        const current = state.sessionId ?? this.#sessionMap.get(state.key);
        if (current !== undefined) {
          state.previousSessionId = current;
          state.previousSessionAt = this.#lastActivityAt(state) ?? this.#now();
        }
        const fresh = this.#mint();
        this.#sessionMap.set(state.key, fresh);
        this.#sessionMap.setCwd(
          state.key,
          this.#sessionMap.getCwd(state.key) ?? this.#config.defaultCwd,
        );
        state.sessionId = fresh;
        state.pendingCreate = true;
        state.running = false;
        state.title = undefined;
        state.status.reset();
        state.progress?.dispose();
        state.progress = undefined;
        state.statusStream?.dispose();
        state.statusStream = undefined;
        state.lastOutput = '';
        this.#bindSession(state, fresh);
        await this.#replyText(
          state,
          `已新建会话 ${fresh}。上一会话可用 /resume 恢复。`,
        );
        return;
      }
      case 'sessions': {
        await this.#replyText(
          state,
          command.all === true ? this.#sessionsAllText(state) : this.#sessionsText(state),
        );
        return;
      }
      case 'status': {
        const title = this.#titleOf(state);
        await this.#replyText(
          state,
          statusText(state.status.get(), {
            ...(title === undefined ? {} : { title }),
            ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
          }),
        );
        return;
      }
      case 'stop': {
        await this.#stop(state);
        return;
      }
      case 'rename': {
        await this.#rename(state, command.title);
        return;
      }
      case 'resume': {
        await this.#resume(state, command.sessionId);
        return;
      }
      case 'persona': {
        const handler = this.#options.persona;
        if (handler === undefined) {
          await this.#replyText(state, '人格命令未接线（caduceus-persona 未挂载）。');
          return;
        }
        const result = await handler(command.action);
        await this.#replyText(state, result.text);
        return;
      }
      case 'help': {
        await this.#replyText(state, helpText());
        return;
      }
      case 'usage': {
        await this.#replyText(state, `${command.reason}\n用法：${command.usage}`);
        return;
      }
      default: {
        // Exhaustiveness guard: a new owned command must be handled here.
        const never: never = command;
        throw new Error(`unhandled owned command: ${JSON.stringify(never)}`);
      }
    }
  }

  async #deliverTurn(state: ScopeState, text: string): Promise<void> {
    const resolved = await this.#tryResolve(state);
    if (resolved === undefined) {
      await this.#replyText(state, '无法创建会话（agents 服务不可用）。');
      return;
    }
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
    const agent = resolved.agent;

    if (!state.running) {
      agent.followup(message);
      return;
    }
    switch (this.#config.busyMode) {
      case 'queue':
        agent.followup(message);
        return;
      case 'steer':
        agent.steer(message);
        return;
      case 'interrupt':
        agent.cancel({ kind: 'user' });
        agent.steer(message);
        return;
    }
  }

  async #settleTurn(state: ScopeState, event: StatusEventLike): Promise<void> {
    state.running = false;
    if (state.progress !== undefined) {
      await this.#renderProgress(state);
      await state.progress.flush();
      state.progress.dispose();
      state.progress = undefined;
    }
    if (state.statusStream !== undefined) await this.#renderStatus(state, true);

    const snapshot = state.status.get();
    const finalText =
      state.lastOutput.trim().length > 0
        ? state.lastOutput
        : `本轮已结束（${statusLabel(snapshot.state)}）。`;
    await this.#sendFinal(state, finalText);

    const kind = turnEndReasonKind(event.data);
    if (shouldNotifyTerminal(kind)) {
      const notice = terminalNotice(kind, snapshot.errorMessage);
      if (notice !== undefined) await this.#replyText(state, notice);
    }
    state.lastOutput = '';
  }

  async #sendFinal(state: ScopeState, text: string): Promise<void> {
    // First line is the current session title when one is known. If the
    // provider title lands after this final message, no edit/retry happens —
    // the next turn naturally carries it.
    const title = this.#titleOf(state)?.trim();
    const header = title !== undefined && title.length > 0 ? `▸ ${title}\n\n` : '';
    const budget = Math.max(1, FINAL_TEXT_MAX_BYTES - Buffer.byteLength(header, 'utf8'));
    const clipped = truncateCardContent(text, { maxBytes: budget }).text;
    const content = `${header}${clipped}`;
    try {
      if (state.lastInboundMessageId !== undefined) {
        await this.#transport.reply(
          state.chatId,
          state.lastInboundMessageId,
          { kind: 'text', text: content },
          { threadId: state.threadId },
        );
      } else {
        await this.#transport.sendText(state.chatId, content);
      }
    } catch (error) {
      this.#logger.warn(`final message failed: ${errorMessage(error)}`);
    }
  }

  /**
   * `/sessions` body. Only THIS scopeKey's sessions are listed (current first,
   * then the previous one); a cross-topic session can never leak in because the
   * bridge only knows the sessions bound to this scope.
   */
  #sessionsText(state: ScopeState): string {
    const current = state.sessionId ?? this.#sessionMap.get(state.key);
    const lines: string[] = [];
    if (current !== undefined) {
      lines.push(this.#sessionListLine(state, current, true));
    }
    if (state.previousSessionId !== undefined && state.previousSessionId !== current) {
      lines.push(this.#sessionListLine(state, state.previousSessionId, false));
    }
    if (lines.length === 0) return '本聊天/话题还没有会话，直接发消息或 /new 开始。';
    return [
      '本聊天/话题的会话：',
      ...lines,
      '用 /rename <标题> 改当前会话名',
    ].join('\n');
  }

  /**
   * One `/sessions` row: `[ * ]▸ <title> · <relative time> · <sessionId 前 8 位>`.
   * Title comes from the cache / `sessionTitle.get(session)`; empty → `（未命名）`.
   * Time is relative to now (`刚刚` / `N 分钟前` / `N 小时前` / `N 天前`), `—` when
   * this process has no timestamp for that session (e.g. a previous session).
   */
  #sessionListLine(state: ScopeState, sessionId: string, isCurrent: boolean): string {
    const title = this.#titleForSessionId(state, sessionId);
    const currentId = state.sessionId ?? this.#sessionMap.get(state.key);
    const timestamp =
      sessionId === currentId ? this.#lastActivityAt(state) : state.previousSessionAt;
    const time = timestamp === undefined ? '—' : relativeTime(timestamp, this.#now());
    const marker = isCurrent ? '* ' : '';
    return `${marker}▸ ${title} · ${time} · ${sessionId.slice(0, 8)}`;
  }

  /**
   * `/sessions --all`: every session of this chatId (legacy pure-chatId key,
   * topic keys, per-user keys), current scope first. Each line adds a scope
   * label; time is relative when this process has the scope state, `—` otherwise.
   */
  #sessionsAllText(state: ScopeState): string {
    const currentId = state.sessionId ?? this.#sessionMap.get(state.key);
    const rows: { key: string; sessionId: string }[] = [];
    for (const key of this.#scopeKeysForChat(state.chatId)) {
      const sessionId = this.#sessionMap.get(key);
      if (sessionId !== undefined) rows.push({ key, sessionId });
    }
    if (currentId !== undefined && !rows.some((row) => row.key === state.key)) {
      rows.push({ key: state.key, sessionId: currentId });
    }
    const current = rows.find((row) => row.key === state.key);
    const others = rows
      .filter((row) => row.key !== state.key)
      .sort((left, right) => left.key.localeCompare(right.key));
    const ordered = [...(current === undefined ? [] : [current]), ...others];
    if (ordered.length === 0) return '本聊天还没有会话，直接发消息或 /new 开始。';
    return [
      '本聊天下的会话（含其他 scope）：',
      ...ordered.map((row) => this.#allSessionLine(state, row)),
      '用 /resume <id 前 8 位> 继续某条会话',
    ].join('\n');
  }

  #allSessionLine(state: ScopeState, row: { readonly key: string; readonly sessionId: string }): string {
    const isCurrent = row.key === state.key;
    const owner = isCurrent ? state : this.#states.get(row.key);
    const title =
      owner !== undefined && owner.sessionId === row.sessionId && owner.title !== undefined
        ? owner.title
        : this.#titleForSessionId(state, row.sessionId);
    const timestamp = owner === undefined ? undefined : this.#lastActivityAt(owner);
    const time = timestamp === undefined ? '—' : relativeTime(timestamp, this.#now());
    const marker = isCurrent ? '* ' : '';
    return `${marker}▸ ${title} · ${time} · ${row.sessionId.slice(0, 8)} · ${this.#scopeLabel(
      state,
      row.key,
    )}`;
  }

  /** Latest timestamp this scope has seen for its current session, if any. */
  #lastActivityAt(state: ScopeState): number | undefined {
    const snapshot = state.status.get();
    return snapshot.startedAt ?? snapshot.endedAt ?? snapshot.lastEventAt;
  }

  #titleForSessionId(state: ScopeState, sessionId: string): string {
    if (state.sessionId === sessionId && state.title !== undefined) return state.title;
    const service = this.#sessionTitle;
    if (service !== undefined) {
      const agent = this.#agents.get(sessionId);
      if (agent !== undefined) {
        try {
          const title = service.get(agent.session)?.title;
          if (title !== undefined && title.trim().length > 0) return title;
        } catch {
          // Fall through to the unnamed placeholder.
        }
      }
    }
    return '（未命名）';
  }

  #titleOf(state: ScopeState): string | undefined {
    if (state.title !== undefined) return state.title;
    return this.#titleOfSession(state);
  }

  #titleOfSession(state: ScopeState): string | undefined {
    const service = this.#sessionTitle;
    if (service === undefined) return undefined;
    const sessionId = state.sessionId ?? this.#sessionMap.get(state.key);
    if (sessionId === undefined) return undefined;
    const agent = this.#agents.get(sessionId);
    if (agent === undefined) return undefined;
    try {
      return service.get(agent.session)?.title;
    } catch {
      return undefined;
    }
  }

  async #stop(state: ScopeState): Promise<void> {
    const sessionId = state.sessionId ?? this.#sessionMap.get(state.key);
    if (sessionId === undefined) {
      await this.#replyText(state, '本聊天/话题还没有会话。');
      return;
    }
    const agent = this.#agents.get(sessionId);
    if (agent === undefined) {
      await this.#replyText(state, '当前没有在跑的会话。');
      return;
    }
    agent.cancel({ kind: 'user' });
    await this.#replyText(state, '已请求停止当前一轮（cancel kind=user）。');
  }

  async #rename(state: ScopeState, title: string): Promise<void> {
    const service = this.#sessionTitle;
    if (service === undefined) {
      await this.#replyText(state, '标题服务未挂载（sessionTitle），无法重命名。');
      return;
    }
    const resolved = await this.#tryResolve(state);
    if (resolved === undefined) {
      await this.#replyText(state, '会话不可用，无法重命名。');
      return;
    }
    try {
      const snapshot = service.rename(resolved.agent.session, title) as
        | { readonly title?: string }
        | undefined;
      const normalized = snapshot?.title ?? title;
      state.title = normalized;
      if (state.statusStream?.messageId !== undefined) await this.#renderStatus(state);
      await this.#replyText(state, `已重命名：${normalized}`);
    } catch (error) {
      if (error instanceof Error && error.name === 'SessionTitleInvalidError') {
        await this.#replyText(state, '标题不能为空或太短，换一个说法吧。');
        return;
      }
      await this.#replyText(state, `重命名失败：${errorMessage(error)}`);
    }
  }

  async #resume(state: ScopeState, requested: string | undefined): Promise<void> {
    if (requested === undefined) {
      const previous = state.previousSessionId;
      if (previous === undefined) {
        await this.#replyText(state, '本聊天/话题没有可恢复的上一条会话（或指定 /resume <id|前缀>）。');
        return;
      }
      await this.#switchSession(state, previous);
      return;
    }

    const query = requested.trim();
    const matches = this.#matchSessionsByChat(state, query);
    const exact = matches.find((match) => match.sessionId === query);
    const selected = exact === undefined ? matches : [exact];

    if (selected.length === 0) {
      if (query.length < 8) {
        await this.#replyText(state, '前缀至少 8 位（或输入完整 sessionId）。');
      } else {
        await this.#replyText(state, `没找到匹配的会话：${query}（可用 /sessions --all 查看）`);
      }
      return;
    }
    if (selected.length > 1) {
      const lines = selected
        .slice(0, 5)
        .map((match) => `· ${match.sessionId.slice(0, 8)} · ${this.#scopeLabel(state, match.keys[0] as string)}`);
      await this.#replyText(
        state,
        `前缀 ${query} 命中 ${selected.length} 条会话，请输入更多字符：\n${lines.join('\n')}`,
      );
      return;
    }
    const target = selected[0] as { sessionId: string; keys: string[] };
    if (query.length < 8 && target.sessionId !== query) {
      await this.#replyText(state, '前缀至少 8 位（或输入完整 sessionId）。');
      return;
    }
    await this.#switchSession(state, target.sessionId);
  }

  /**
   * Resume `target` and, only on success, point THIS scopeKey's mapping at it
   * (no new session, no re-mint). Used by /resume for both the no-arg previous
   * case and the id/prefix case.
   */
  async #switchSession(state: ScopeState, target: string): Promise<void> {
    const current = state.sessionId ?? this.#sessionMap.get(state.key);
    try {
      const { agent } = await this.#agents.resume({ resumeSessionId: target });
      if (current !== undefined && current !== target) {
        state.previousSessionId = current;
        state.previousSessionAt = this.#lastActivityAt(state) ?? this.#now();
      }
      this.#sessionMap.set(state.key, target);
      state.sessionId = target;
      state.pendingCreate = false;
      state.running = false;
      state.title = undefined;
      state.status.reset();
      this.#bindSession(state, target);
      this.#bindSession(state, String(agent.session.id));
      await this.#afterAgentReady(state);
      await this.#replyText(state, `已恢复会话 ${target}。`);
    } catch (error) {
      await this.#replyText(state, `恢复会话失败：${errorMessage(error)}`);
    }
  }

  /** Chat-scope keys (all scopes of one chatId) from the session map. */
  #scopeKeysForChat(chatId: string): string[] {
    return this.#sessionMap
      .keys()
      .filter((key) => key === chatId || key.startsWith(`${chatId}${SCOPE_KEY_SEPARATOR}`));
  }

  /** `/resume` matches: session ids under any scope of this chatId. */
  #matchSessionsByChat(
    state: ScopeState,
    query: string,
  ): { readonly sessionId: string; readonly keys: string[] }[] {
    const matches = new Map<string, string[]>();
    for (const key of this.#scopeKeysForChat(state.chatId)) {
      const sessionId = this.#sessionMap.get(key);
      if (sessionId === undefined) continue;
      if (sessionId !== query && !sessionId.startsWith(query)) continue;
      const keys = matches.get(sessionId);
      if (keys === undefined) matches.set(sessionId, [key]);
      else keys.push(key);
    }
    return [...matches.entries()].map(([sessionId, keys]) => ({ sessionId, keys }));
  }

  /** Human scope label for `/sessions --all` and `/resume` candidates. */
  #scopeLabel(state: ScopeState, key: string): string {
    const separatorAt = key.indexOf(SCOPE_KEY_SEPARATOR);
    if (separatorAt === -1) return state.chatType === 'p2p' ? '私聊' : '旧会话';
    const suffix = key.slice(separatorAt + 1);
    if (suffix.startsWith('omt_')) return `话题 ${suffix.slice(0, 8)}`;
    if (suffix.startsWith('ou_')) return `用户 ${suffix.slice(0, 8)}`;
    return '旧会话';
  }

  async #tryResolve(
    state: ScopeState,
  ): Promise<{ agent: AgentLike; sessionId: string; cwd: string } | undefined> {
    try {
      const resolved = await this.#resolveAgent(state);
      await this.#afterAgentReady(state);
      return resolved;
    } catch (error) {
      this.#logger.warn(`agent resolution failed for ${state.key}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * The first status-card render can happen before the agent (and therefore the
   * title service) is resolvable; title events that arrive earlier are lost.
   * Once create/resume returns, pull the title from the service and force one
   * in-place re-render of the EXISTING status card (same message_id, no new
   * message). The session/title subscription still handles later changes.
   */
  async #afterAgentReady(state: ScopeState): Promise<void> {
    const title = this.#titleOfSession(state);
    if (title !== undefined) state.title = title;
    if (state.statusStream?.messageId !== undefined) await this.#renderStatus(state);
  }

  async #resolveAgent(
    state: ScopeState,
  ): Promise<{ agent: AgentLike; sessionId: string; cwd: string }> {
    const cwd = this.#sessionMap.getCwd(state.key) ?? this.#config.defaultCwd;
    let sessionId = state.sessionId ?? this.#sessionMap.get(state.key);

    if (sessionId === undefined) {
      sessionId = this.#mint();
      this.#sessionMap.set(state.key, sessionId);
      this.#sessionMap.setCwd(state.key, cwd);
      this.#bindSession(state, sessionId);
      const { agent } = await this.#agents.create({ sessionId, meta: { cwd } });
      this.#bindSession(state, String(agent.session.id));
      state.pendingCreate = false;
      return { agent, sessionId, cwd };
    }

    state.sessionId = sessionId;
    this.#bindSession(state, sessionId);
    const live = this.#agents.get(sessionId);
    if (live !== undefined) return { agent: live, sessionId, cwd };

    if (state.pendingCreate) {
      const { agent } = await this.#agents.create({ sessionId, meta: { cwd } });
      this.#bindSession(state, String(agent.session.id));
      state.pendingCreate = false;
      return { agent, sessionId, cwd };
    }

    try {
      const { agent } = await this.#agents.resume({ resumeSessionId: sessionId });
      this.#bindSession(state, String(agent.session.id));
      return { agent, sessionId, cwd };
    } catch (error) {
      // The mapped session has no persisted log (or is stale): remint rather
      // than leaving the chat permanently broken.
      this.#logger.warn(`resume failed for ${sessionId}; reminting: ${errorMessage(error)}`);
      const fresh = this.#mint();
      state.previousSessionId = sessionId;
      state.previousSessionAt = this.#lastActivityAt(state) ?? this.#now();
      state.sessionId = fresh;
      this.#sessionMap.set(state.key, fresh);
      this.#bindSession(state, fresh);
      const { agent } = await this.#agents.create({ sessionId: fresh, meta: { cwd } });
      this.#bindSession(state, String(agent.session.id));
      state.pendingCreate = false;
      return { agent, sessionId: fresh, cwd };
    }
  }

  #bindSession(state: ScopeState, sessionId: string): void {
    for (const [id, key] of this.#scopeBySession) {
      if (key === state.key && id !== sessionId) this.#scopeBySession.delete(id);
    }
    this.#scopeBySession.set(sessionId, state.key);
    state.sessionId = sessionId;
  }

  #stateFor(message: InboundMessage): ScopeState {
    const key = scopeKey(
      message.chatType,
      message.chatId,
      message.threadId,
      message.senderOpenId,
      this.#config.groupSessionsPerUser,
    );
    const existing = this.#states.get(key);
    if (existing !== undefined) return existing;
    const created: ScopeState = {
      key,
      chatId: message.chatId,
      chatType: message.chatType,
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
      pendingCreate: false,
      running: false,
      status: new StatusTracker(),
      lastOutput: '',
    };
    this.#states.set(key, created);
    return created;
  }

  /**
   * Trigger gate (user decision after real-device feedback):
   * - p2p: no mention needed;
   * - group chat: ALWAYS requires an @-mention of this bot — including group
   *   topics, whether or not the scope already has a session.
   *
   * The previous "bound topic is exempt" shortcut was removed because two bots
   * sharing a topic both answered an unmentioned message. A single-person-group
   * exemption is also intentionally not implemented (chat-membership API cost).
   */
  #accepts(message: InboundMessage): boolean {
    if (message.chatType === 'p2p') return true;

    const mentions = message.mentions ?? [];
    const botOpenId = this.#transport.getBotOpenId?.();
    if (typeof botOpenId === 'string' && botOpenId.length > 0) {
      if (mentions.includes(botOpenId)) return true;
    } else if (mentions.length > 0) {
      // bot/v3/info failed: accept any mention rather than dropping every group
      // message; logged once per message at debug level for diagnosis.
      this.#logger.debug('bot open id unavailable; accepting group message carrying a mention');
      return true;
    }

    this.#logger.debug(
      `group message without mention ignored (chat ${message.chatId}, thread ${message.threadId ?? '-'})`,
    );
    return false;
  }

  #allowed(message: InboundMessage): boolean {
    const chats = this.#config.allowedChats;
    if (chats.length > 0 && !chats.includes(message.chatId)) return false;
    const users = this.#config.allowedUsers;
    if (users.length > 0 && !users.includes(message.senderOpenId)) return false;
    return true;
  }

  #makeCardStream(state: ScopeState): CardStream {
    const channel: CardChannel = {
      create: (card: FeishuCard) => this.#sendNewCard(state, card),
      update: async (messageId: string, card: FeishuCard) => {
        await this.#transport.updateCard(messageId, card);
      },
    };
    return new CardStream(channel, {
      throttleMs: this.#config.cardThrottleMs,
      clock: this.#clock,
      onError: (error: unknown) => this.#logger.warn(`card stream failed: ${errorMessage(error)}`),
    });
  }

  async #sendNewCard(state: ScopeState, card: FeishuCard): Promise<{ messageId: string }> {
    if (state.lastInboundMessageId !== undefined) {
      return this.#transport.reply(
        state.chatId,
        state.lastInboundMessageId,
        { kind: 'card', card },
        { threadId: state.threadId },
      );
    }
    return this.#transport.sendCard(state.chatId, card);
  }

  async #renderProgress(state: ScopeState): Promise<void> {
    const stream = state.progress;
    if (stream === undefined) return;
    const snapshot = state.status.get();
    await stream.set(
      this.#progressCardFor(state, snapshot),
    );
  }

  #progressCardFor(state: ScopeState, snapshot: StatusSnapshot): FeishuCard {
    return progressCardForSnapshot(snapshot, state.lastOutput, this.#now());
  }

  async #renderStatus(state: ScopeState, flush = false): Promise<void> {
    let stream = state.statusStream;
    if (stream === undefined) {
      stream = this.#makeCardStream(state);
      state.statusStream = stream;
    }
    const snapshot = state.status.get();
    const card = statusCard({
      title: '飞书会话 · 状态',
      lines: statusCardLines(snapshot, state.title === undefined ? {} : { title: state.title }),
      template: statusTemplate(snapshot.state),
    });
    await stream.set(card);
    if (flush) await stream.flush();
  }

  async #replyText(state: ScopeState, text: string): Promise<void> {
    if (text.length === 0) return;
    try {
      if (state.lastInboundMessageId !== undefined) {
        await this.#transport.reply(
          state.chatId,
          state.lastInboundMessageId,
          { kind: 'text', text },
          { threadId: state.threadId },
        );
      } else {
        await this.#transport.sendText(state.chatId, text);
      }
    } catch (error) {
      this.#logger.warn(`reply failed: ${errorMessage(error)}`);
    }
  }
}

/** Build the process card for one snapshot (exported for render tests). */
export function progressCardForSnapshot(
  snapshot: StatusSnapshot,
  tail: string,
  now: number,
): FeishuCard {
  return progressCard({
    title: '飞书会话 · 过程',
    stateLabel: statusLabel(snapshot.state),
    steps: snapshot.steps,
    tools: snapshot.tools,
    ...(snapshot.startedAt === undefined ? {} : { startedAt: snapshot.startedAt }),
    now,
    tail,
  });
}
