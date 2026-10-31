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
import { evaluateGate, logGate } from '../gate.js';
import { silentLogger, type LoggerLike } from '../logger.js';
import {
  formatScopeLine,
  sessionIdTimestamp,
  sessionTimeLabel,
  shortSessionId,
} from '../observability.js';
import { writeOwnership, type SessionScopeKind } from '../ownership.js';
import {
  finalCard,
  finalCardPlainText,
  progressCard,
  type FinalCardInput,
} from '../render/cards.js';
import { CardStream, systemClock } from '../render/stream.js';
import type { CardChannel, Clock } from '../render/stream.js';
import { mintSessionId, scopeKey, SCOPE_KEY_SEPARATOR, type SessionStore } from '../session-key.js';
import {
  StatusTracker,
  shouldNotifyTerminal,
  recentEventText,
  statusLabel,
  statusTemplate,
  statusText,
  terminalNotice,
  type StatusEventLike,
  type StatusSnapshot,
} from '../status.js';
import type { ChatType, FeishuCard, InboundMessage, Transport } from '../transport/types.js';
import { ScopeQueue } from './scope-queue.js';
import type {
  AgentLike,
  AgentPresetsLike,
  AgentsLike,
  BridgeConfig,
  BridgeOptions,
  SessionTitleLike,
} from './types.js';

/** Final-answer text cap from the design doc (§6 L3: 150 KB). */

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
  lastOutput: string;
  /** Latest session title (from a `session/title` event or `/rename`). */
  title?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  readonly #sessionExists: (sessionId: string) => boolean;
  readonly #ownershipDir: string | undefined;
  readonly #sessionIdsProvider: () => readonly string[];
  readonly #agentPresetsProvider: (() => AgentPresetsLike | undefined) | undefined;
  #agentPresetsCache: AgentPresetsLike | undefined;
  #agentPresetsLogged = false;
  readonly #sessionPresetLookup: ((sessionId: string) => string | undefined) | undefined;
  /** Session ids whose preset mount failed (shown as `（preset 未挂载）`). */
  readonly #presetFailures = new Set<string>();
  readonly #sessionTitleProvider: () => SessionTitleLike | undefined;
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
    this.#sessionExists = options.sessionExists ?? (() => true);
    this.#ownershipDir = options.ownershipDir;
    this.#sessionIdsProvider = options.sessionIdsProvider ?? (() => []);
    this.#agentPresetsProvider =
      options.agentPresetsProvider ??
      (options.agentPresets === undefined ? undefined : () => options.agentPresets);
    this.#sessionPresetLookup = options.sessionPresetLookup;
    const provider =
      options.sessionTitleProvider ??
      (options.sessionTitle === undefined ? undefined : () => options.sessionTitle);
    this.#sessionTitleProvider = provider ?? (() => undefined);
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
    const decision = evaluateGate({
      chatType: message.chatType,
      chatId: message.chatId,
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
      senderOpenId: message.senderOpenId,
      text: message.text,
      ...(message.mentions === undefined ? {} : { mentions: message.mentions }),
      ...(this.#transport.getBotOpenId?.() === undefined
        ? {}
        : { botOpenId: this.#transport.getBotOpenId?.() }),
      allowedChats: this.#config.allowedChats,
      allowedUsers: this.#config.allowedUsers,
    });
    logGate(this.#logger, decision, {
      chatId: message.chatId,
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
      senderOpenId: message.senderOpenId,
    });
    if (!decision.accept) return;
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
        await this.#renderProgress(state);
        break;
      }
      case 'step/start':
      case 'step/end':
      case 'tool/call':
      case 'tool/result': {
        await this.#renderProgress(state);
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
        // Re-render the EXISTING process card in place (throttled); never
        // create a new message just because the title arrived late.
        if (state.progress?.messageId !== undefined) await this.#renderProgress(state);
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
    const trimmed = raw.trim();
    if (plan.kind === 'denied') {
      this.#logger.info(`command: deny ${trimmed.slice(0, 40)}`);
      await this.#replyText(state, `/${plan.name} 仅 Web 可执行，飞书里不转发。`);
      return;
    }
    if (plan.kind === 'owned') {
      this.#logger.info(`command: ${trimmed.slice(0, 40)}`);
      await this.#runOwned(state, plan.command);
      return;
    }
    if (plan.name.length === 0) {
      this.#logger.info(`command: parse-fail ${trimmed.slice(0, 40)}`);
    } else {
      this.#logger.info(`command: unknown passthrough ${trimmed.slice(0, 40)}`);
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
        // Materialize the session NOW: a map entry pointing at a session that
        // was never created becomes a ghost id that fails the next resume.
        const current = state.sessionId ?? this.#sessionMap.get(state.key);
        const cwd = this.#sessionMap.getCwd(state.key) ?? this.#config.defaultCwd;
        const fresh = this.#mint();
        try {
          const { agent } = await this.#createAgent(state, fresh, cwd);
          // Commit only after create succeeded; on failure nothing is written.
          if (current !== undefined) {
            state.previousSessionId = current;
            state.previousSessionAt = this.#lastActivityAt(state) ?? this.#now();
          }
          this.#sessionMap.set(state.key, fresh);
          if (this.#sessionMap.getCwd(state.key) === undefined) {
            this.#sessionMap.setCwd(state.key, cwd);
          }
          state.sessionId = fresh;
          state.pendingCreate = false;
          state.running = false;
          state.title = undefined;
          state.status.reset();
          state.progress?.dispose();
          state.progress = undefined;
          state.lastOutput = '';
          this.#bindSession(state, fresh);
          this.#bindSession(state, String(agent.session.id));
          await this.#replyText(
            state,
            `已新建会话 ${shortSessionId(fresh)}。上一会话可用 /resume 恢复。`,
          );
        } catch (error) {
          await this.#replyText(state, `新建会话失败：${errorMessage(error)}`);
        }
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
      case 'adopt': {
        await this.#adopt(state, command.sessionId);
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
    const snapshot = state.status.get();
    const body =
      state.lastOutput.trim().length > 0
        ? state.lastOutput
        : `本轮已结束（${statusLabel(snapshot.state)}）。`;
    const finalInput = this.#finalCardInput(state, snapshot, body);

    const stream = state.progress;
    const messageId = stream?.messageId;
    if (stream !== undefined) {
      await stream.flush();
      stream.dispose();
      state.progress = undefined;
    }

    const card = finalCard(finalInput);
    if (messageId !== undefined) {
      try {
        await this.#transport.updateCard(messageId, card);
      } catch (error) {
        await this.#finalFallback(state, finalInput, error);
      }
    } else {
      try {
        await this.#sendNewCard(state, card);
      } catch (error) {
        await this.#finalFallback(state, finalInput, error);
      }
    }

    const kind = turnEndReasonKind(event.data);
    if (shouldNotifyTerminal(kind)) {
      const notice = terminalNotice(kind, snapshot.errorMessage);
      if (notice !== undefined) await this.#replyText(state, notice);
    }
    state.lastOutput = '';
  }

  #finalCardInput(
    state: ScopeState,
    snapshot: StatusSnapshot,
    body: string,
  ): FinalCardInput {
    const sessionTitle = this.#titleOf(state)?.trim() ?? state.title;
    return {
      title: '飞书会话 · 过程',
      stateLabel: statusLabel(snapshot.state),
      steps: snapshot.steps,
      tools: snapshot.tools,
      ...(sessionTitle === undefined ? {} : { sessionTitle }),
      recentEvent: recentEventText(snapshot),
      ...(snapshot.startedAt === undefined ? {} : { startedAt: snapshot.startedAt }),
      ...(snapshot.endedAt === undefined ? {} : { endedAt: snapshot.endedAt }),
      body,
      template: statusTemplate(snapshot.state),
    };
  }

  /** The ONLY fallback path: card edit failed, so send the same content as text once. */
  async #finalFallback(state: ScopeState, input: FinalCardInput, error: unknown): Promise<void> {
    this.#logger.warn(`final fallback to text: ${errorMessage(error)}`);
    await this.#replyText(state, finalCardPlainText(input));
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
      sessionIdTimestamp(sessionId) ??
      (sessionId === currentId ? this.#lastActivityAt(state) : state.previousSessionAt);
    const time = sessionTimeLabel(timestamp, this.#now());
    const marker = isCurrent ? '* ' : '';
    return `${marker}▸ ${title} · ${time} · ${shortSessionId(sessionId)}${this.#ghostSuffix(sessionId)}`;
  }

  /**
   * `/sessions --all`: every session of this chatId (legacy pure-chatId key,
   * topic keys, per-user keys), current scope first. Each line adds a scope
   * label; time is relative when this process has the scope state, `—` otherwise.
   */
  #sessionsAllText(state: ScopeState): string {
    interface Row {
      readonly key: string;
      readonly sessionId: string;
      readonly current: boolean;
    }
    const rows: Row[] = [];
    const seen = new Set<string>();
    const add = (key: string, sessionId: string | undefined, current: boolean): void => {
      if (sessionId === undefined || seen.has(sessionId)) return;
      seen.add(sessionId);
      rows.push({ key, sessionId, current });
    };

    // Current scope: current id first, then its durable history.
    const currentId = state.sessionId ?? this.#sessionMap.get(state.key);
    add(state.key, currentId, true);
    for (const id of this.#sessionMap.history(state.key)) add(state.key, id, false);

    // Other scopes of this chat: current id then history (deterministic order).
    for (const key of [...this.#scopeKeysForChat(state.chatId)].sort()) {
      if (key === state.key) continue;
      add(key, this.#sessionMap.get(key), false);
      for (const id of this.#sessionMap.history(key)) add(key, id, false);
    }

    if (rows.length === 0) return '本聊天还没有会话，直接发消息或 /new 开始。';
    return [
      '本聊天下的会话（含其他 scope 与历史）：',
      ...rows.map((row) => this.#allSessionLine(state, row)),
      '用 /resume <id 后 8 位> 继续某条会话',
    ].join('\n');
  }

  #allSessionLine(
    state: ScopeState,
    row: { readonly key: string; readonly sessionId: string; readonly current: boolean },
  ): string {
    const isCurrent = row.current;
    const owner = isCurrent ? state : this.#states.get(row.key);
    const title =
      owner !== undefined && owner.sessionId === row.sessionId && owner.title !== undefined
        ? owner.title
        : this.#titleForSessionId(state, row.sessionId);
    const timestamp =
      sessionIdTimestamp(row.sessionId) ??
      (owner === undefined ? undefined : this.#lastActivityAt(owner));
    const time = sessionTimeLabel(timestamp, this.#now());
    const marker = isCurrent ? '* ' : '';
    return `${marker}▸ ${title} · ${time} · ${shortSessionId(row.sessionId)} · ${this.#scopeLabel(
      state,
      row.key,
    )}${this.#ghostSuffix(row.sessionId)}`;
  }

  /** Latest timestamp this scope has seen for its current session, if any. */
  #lastActivityAt(state: ScopeState): number | undefined {
    const snapshot = state.status.get();
    return snapshot.startedAt ?? snapshot.endedAt ?? snapshot.lastEventAt;
  }

  /** A session is "landed" when it is live now or has a durable log on disk. */
  #isLanded(sessionId: string): boolean {
    if (this.#agents.get(sessionId) !== undefined) return true;
    return this.#sessionExists(sessionId);
  }

  #ghostSuffix(sessionId: string): string {
    return this.#isLanded(sessionId) ? '' : ' （未落地）';
  }

  #titleForSessionId(state: ScopeState, sessionId: string): string {
    if (state.sessionId === sessionId && state.title !== undefined) return state.title;
    const service = this.#sessionTitleService();
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

  /** Resolve the title service on each use (it may register after apply). */
  #sessionTitleService(): SessionTitleLike | undefined {
    return this.#sessionTitleProvider();
  }

  #titleOf(state: ScopeState): string | undefined {
    if (state.title !== undefined) return state.title;
    return this.#titleOfSession(state);
  }

  #titleOfSession(state: ScopeState): string | undefined {
    const service = this.#sessionTitleService();
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
    const service = this.#sessionTitleService();
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
      if (state.progress?.messageId !== undefined) await this.#renderProgress(state);
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
        await this.#replyText(state, '尾号至少 8 位（或输入完整 sessionId）。');
      } else {
        await this.#replyText(state, `没找到匹配的会话：${query}（可用 /sessions --all 查看）`);
      }
      return;
    }
    if (selected.length > 1) {
      const lines = selected
        .slice(0, 5)
        .map((match) => `· ${shortSessionId(match.sessionId)} · ${this.#scopeLabel(state, match.keys[0] as string)}`);
      await this.#replyText(
        state,
        `尾号 ${query} 命中 ${selected.length} 条会话，请输入更多字符：\n${lines.join('\n')}`,
      );
      return;
    }
    const target = selected[0] as { sessionId: string; keys: string[] };
    if (query.length < 8 && target.sessionId !== query) {
      await this.#replyText(state, '尾号至少 8 位（或输入完整 sessionId）。');
      return;
    }
    await this.#switchSession(state, target.sessionId);
  }

  /**
   * Resume `target` and, only on success, point THIS scopeKey's mapping at it
   * (no new session, no re-mint). Used by /resume for both the no-arg previous
   * case and the id/prefix case.
   */
  async #switchSession(state: ScopeState, target: string, verb = '已恢复会话'): Promise<void> {
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
      await this.#replyText(state, `${verb} ${target}。`);
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
    const consider = (key: string, sessionId: string): void => {
      if (sessionId !== query) {
        if (query.length < 8 || !sessionId.endsWith(query)) return;
      }
      const keys = matches.get(sessionId);
      if (keys === undefined) matches.set(sessionId, [key]);
      else if (!keys.includes(key)) keys.push(key);
    };
    for (const key of this.#scopeKeysForChat(state.chatId)) {
      const current = this.#sessionMap.get(key);
      if (current !== undefined) consider(key, current);
      for (const sessionId of this.#sessionMap.history(key)) consider(key, sessionId);
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

  #scopeKind(state: ScopeState): SessionScopeKind {
    if (state.chatType === 'p2p') return 'p2p';
    if (state.threadId !== undefined) return 'topic';
    return 'group-user';
  }

  /** Resolve the preset service lazily; cache only successful lookups. */
  #resolveAgentPresets(): AgentPresetsLike | undefined {
    if (this.#agentPresetsCache !== undefined) return this.#agentPresetsCache;
    const service = this.#agentPresetsProvider?.();
    if (service !== undefined) this.#agentPresetsCache = service;
    return service;
  }

  /**
   * Mount the configured agent preset in the unpublished agent scope.
   * Idempotent for resumes: a context that already reports a composed preset is
   * left alone. Failures are contained (the session stays usable) and recorded
   * so the card state line can show `（preset 未挂载）`.
   */
  async #mountPreset(sessionId: string, agentCtx: unknown): Promise<void> {
    const preset = this.#config.agentPreset ?? 'standard';
    const presets = this.#resolveAgentPresets();
    if (presets === undefined) {
      // Never cache the miss: the service may register after this attempt.
      this.#presetFailures.add(sessionId);
      this.#logger.warn(
        `agentPresets service unavailable; preset ${preset} not mounted for ${sessionId}`,
      );
      return;
    }
    if (!this.#agentPresetsLogged) {
      this.#agentPresetsLogged = true;
      this.#logger.info(`agentPresets resolved; mounting ${preset}`);
    }
    try {
      if (presets.composedPreset(agentCtx) !== undefined) return;
      await presets.mount(agentCtx, preset);
    } catch (error) {
      this.#presetFailures.add(sessionId);
      this.#logger.warn(
        `agent preset mount failed for ${sessionId} (${preset}): ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Create an agent with dsh's own meta fields PLUS caduceus ownership, then
   * persist the ownership sidecar. The sidecar is the durable part because dsh
   * 0.2.1-rc.2 rebuilds its header from known fields and drops unknown meta.
   */
  async #createAgent(
    state: ScopeState,
    sessionId: string,
    cwd: string,
  ): Promise<{ readonly agent: AgentLike }> {
    const caduceus = { chatId: state.chatId, scopeKey: state.key, kind: this.#scopeKind(state) };
    const agentPreset = this.#config.agentPreset ?? 'standard';
    const { agent } = await this.#agents.create({
      sessionId,
      meta: { cwd, caduceus, agentPreset },
      setup: async (agentCtx) => {
        await this.#mountPreset(sessionId, agentCtx);
      },
    });
    try {
      await writeOwnership(
        sessionId,
        caduceus,
        this.#ownershipDir === undefined ? {} : { dir: this.#ownershipDir },
      );
    } catch (error) {
      this.#logger.warn(`ownership write failed for ${sessionId}: ${errorMessage(error)}`);
    }
    return { agent };
  }

  /**
   * `/adopt <id|尾号>`: bind an unowned session to the CURRENT scope key.
   * - found in another scope of this chat → refuse (tell the user where it is);
   * - found in this scope's current/history → promote it to current;
   * - found only on disk (orphan) → resume it, then append+switch;
   * - ambiguous → list candidates; none → "没找到".
   */
  async #adopt(state: ScopeState, query: string): Promise<void> {
    const exactQuery = query.trim();
    const known = this.#matchSessionsByChat(state, exactQuery);
    const keysById = new Map<string, string[]>();
    for (const match of known) keysById.set(match.sessionId, [...match.keys]);
    for (const sessionId of this.#sessionIdsProvider()) {
      if (!keysById.has(sessionId)) keysById.set(sessionId, []);
    }
    const matched = [...keysById.keys()].filter(
      (sessionId) =>
        sessionId === exactQuery ||
        (exactQuery.length >= 8 && sessionId.endsWith(exactQuery)),
    );
    const exact = matched.find((sessionId) => sessionId === exactQuery);
    const selected = exact === undefined ? matched : [exact];

    if (selected.length === 0) {
      if (exactQuery.length < 8) {
        await this.#replyText(state, '尾号至少 8 位（或输入完整 sessionId）。');
      } else {
        await this.#replyText(state, `没找到可收养的会话：${exactQuery}`);
      }
      return;
    }
    if (selected.length > 1) {
      const lines = selected.slice(0, 5).map((sessionId) => {
        const keys = keysById.get(sessionId) ?? [];
        const label = keys.length === 0 ? '未归属' : this.#scopeLabel(state, keys[0] as string);
        return `· ${shortSessionId(sessionId)} · ${label}`;
      });
      await this.#replyText(
        state,
        `尾号 ${exactQuery} 命中 ${selected.length} 条会话，请输入更多字符：\n${lines.join('\n')}`,
      );
      return;
    }

    const target = selected[0] as string;
    const keys = keysById.get(target) ?? [];
    const foreign = keys.find((key) => key !== state.key);
    if (foreign !== undefined) {
      await this.#replyText(
        state,
        `该会话已在其他 scope 下（${this.#scopeLabel(state, foreign)}），不重复收养。`,
      );
      return;
    }
    await this.#switchSession(state, target, '已收养会话');
  }

  async #tryResolve(
    state: ScopeState,
  ): Promise<{ agent: AgentLike; sessionId: string; cwd: string } | undefined> {
    try {
      const resolved = await this.#resolveAgent(state);
      this.#logger.info(
        formatScopeLine(
          state.chatType,
          state.key,
          resolved.sessionId,
          this.#config.groupSessionsPerUser,
        ),
      );
      await this.#afterAgentReady(state);
      return resolved;
    } catch (error) {
      this.#logger.warn(`agent resolution failed for ${state.key}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * The first process-card render can happen before the agent (and therefore
   * the title service) is resolvable; title events that arrive earlier are
   * lost. Once create/resume returns, pull the title from the service and force
   * one in-place re-render of the EXISTING process card (same message_id, no new
   * message). The session/title subscription still handles later changes.
   */
  async #afterAgentReady(state: ScopeState): Promise<void> {
    const title = this.#titleOfSession(state);
    if (title !== undefined) state.title = title;
    if (state.progress?.messageId !== undefined) await this.#renderProgress(state);
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
      const { agent } = await this.#createAgent(state, sessionId, cwd);
      this.#bindSession(state, String(agent.session.id));
      state.pendingCreate = false;
      return { agent, sessionId, cwd };
    }

    state.sessionId = sessionId;
    this.#bindSession(state, sessionId);
    const live = this.#agents.get(sessionId);
    if (live !== undefined) return { agent: live, sessionId, cwd };

    if (state.pendingCreate) {
      const { agent } = await this.#createAgent(state, sessionId, cwd);
      this.#bindSession(state, String(agent.session.id));
      state.pendingCreate = false;
      return { agent, sessionId, cwd };
    }

    try {
      // A session header that already records a preset must not be mounted
      // again; legacy headers (no agentPreset) get the setup mount below.
      const persistedPreset = this.#sessionPresetLookup?.(sessionId);
      const { agent } = await this.#agents.resume({
        resumeSessionId: sessionId,
        ...(persistedPreset === undefined
          ? {
              setup: async (agentCtx: unknown) => {
                await this.#mountPreset(sessionId, agentCtx);
              },
            }
          : {}),
      });
      this.#bindSession(state, String(agent.session.id));
      return { agent, sessionId, cwd };
    } catch (error) {
      // The mapped session has no persisted log (or is stale): remint rather
      // than leaving the chat permanently broken.
      const fresh = this.#mint();
      this.#logger.warn(
        `resume failed for ${sessionId}: ${errorMessage(error)}; old id never landed, reminting (old=${sessionId}, new=${fresh})`,
      );
      state.previousSessionId = sessionId;
      state.previousSessionAt = this.#lastActivityAt(state) ?? this.#now();
      state.sessionId = fresh;
      this.#sessionMap.set(state.key, fresh);
      this.#bindSession(state, fresh);
      const { agent } = await this.#createAgent(state, fresh, cwd);
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
    return progressCardForSnapshot(
      snapshot,
      state.title,
      recentEventText(snapshot),
      state.lastOutput,
      this.#now(),
      state.sessionId !== undefined && this.#presetFailures.has(state.sessionId),
    );
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
  sessionTitle: string | undefined,
  recentEvent: string,
  tail: string,
  now: number,
  presetMissing = false,
): FeishuCard {
  return progressCard({
    title: '飞书会话 · 过程',
    stateLabel: statusLabel(snapshot.state),
    steps: snapshot.steps,
    tools: snapshot.tools,
    ...(sessionTitle === undefined ? {} : { sessionTitle }),
    recentEvent,
    ...(tail.length === 0 ? {} : { tail }),
    ...(presetMissing ? { presetMissing: true } : {}),
    ...(snapshot.startedAt === undefined ? {} : { startedAt: snapshot.startedAt }),
    now,
  });
}
