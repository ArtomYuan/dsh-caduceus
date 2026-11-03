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
 * @module dsh-caduceus/bridge/bridge
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { planSlashLine, type OwnedCommand } from '../commands/dispatch.js';
import { helpText, parseCommand } from '../commands/parse.js';
import { evaluateGate, logGate } from '../gate.js';
import { silentLogger, type LoggerLike } from '../logger.js';
import {
  formatScopeLine,
  sessionIdTimestamp,
  sessionTimeLabel,
  shortSessionId,
} from '../observability.js';
import {
  buildDoctorReport,
  renderDoctorJson,
  renderDoctorText,
  type DoctorLastTurn,
  type DoctorSessionInfo,
} from '../doctor.js';
import { writeOwnership, type SessionScopeKind } from '../ownership.js';
import { defaultExportCacheDir } from '../home.js';
import { extractMediaMarkers, resolveMedia } from '../media.js';
import { aggregateUsage, renderUsageReport } from '../usage.js';
import { aggregateMetrics, formatMetricsLine } from '../metrics.js';
import { presetLabel, t, type Lang } from '../i18n.js';
import {
  buildPermissionCard,
  renderPermissionText,
  type PermissionView,
} from '../render/permission-card.js';
import {
  readSessionLogFile,
  renderExportJsonl,
  renderExportMarkdown,
  truncateExport,
  writeExportFile,
} from '../export.js';
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
  stateForTurnEnd,
  recentEventText,
  statusLabel,
  statusTemplate,
  statusText,
  terminalNotice,
  type StatusEventLike,
  type StatusState,
  type StatusSnapshot,
} from '../status.js';
import type {
  CardAction,
  ChatType,
  FeishuCard,
  InboundAttachment,
  InboundMessage,
  Transport,
} from '../transport/types.js';
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
  /** Latest sender; owner of interactive approval/question cards. */
  ownerOpenId?: string;
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
  /** Stop button was accepted for the current turn. */
  stopRequested?: boolean;
  /** Durable session events seen by this process (metrics source). */
  logEvents: unknown[];
  /** Cached most recent agent request (used by /doctor on command turns). */
  lastAgentTurn?: DoctorLastTurn;
  /** Latest session title (from a `session/title` event or `/rename`). */
  title?: string;
  /** Accepted inbound messages awaiting a turn/end reaction transition. */
  reactionQueue: string[];
  /** Start-reaction promises keyed by message id (to order remove after add). */
  reactionStarts: Map<string, Promise<string | undefined>>;
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
  readonly #selfCheck: import('../selfcheck.js').SelfChecker | undefined;
  readonly #agentCtxBySession = new Map<string, unknown>();
  readonly #toolsCheckedSessions = new Set<string>();
  #approvalMissingWarned = false;
  #botIdentityErrorLogged = false;
  /** Last fail-id set already notified into the conversation. */
  #selfCheckNotifiedSignature: string | undefined;
  /** Session ids whose preset mount failed (shown as `（preset 未挂载）`). */
  readonly #presetFailures = new Set<string>();
  readonly #sessionTitleProvider: () => SessionTitleLike | undefined;
  readonly #queue = new ScopeQueue();
  readonly #states = new Map<string, ScopeState>();
  readonly #chatIdBySession = new Map<string, string>();
  readonly #permissionCards = new Map<string, { key: string; ownerOpenId?: string }>();
  readonly #stopCards = new Map<string, string>();
  readonly #stopClicks = new Map<string, number>();
  readonly #sessionMetrics = new Map<
    string,
    {
      readonly sessionId: string;
      readonly metrics: ReturnType<typeof aggregateMetrics>;
      readonly refreshedAtSeq: number;
      readonly turn: number;
    }
  >();
  readonly #metricsFallbackWarned = new Set<string>();
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
    this.#selfCheck = options.selfCheck;
    const provider =
      options.sessionTitleProvider ??
      (options.sessionTitle === undefined ? undefined : () => options.sessionTitle);
    this.#sessionTitleProvider = provider ?? (() => undefined);
    if (!this.#sessionMap.isLoaded) this.#sessionMap.load();
    for (const key of this.#sessionMap.keys()) {
      const sessionId = this.#sessionMap.get(key);
      if (sessionId !== undefined) this.#scopeBySession.set(sessionId, key);
    }
    if (options.interactive !== undefined && options.rootCtx !== undefined) {
      options.interactive.registerRoot(options.rootCtx, {
        ownsSession: (sessionId) => this.ownsSession(sessionId),
        contextFor: (sessionId) => this.#interactiveContext(sessionId),
      });
    }
  }

  /** True when a session id belongs to a scope this bridge renders. */
  ownsSession(sessionId: string): boolean {
    return this.#scopeBySession.has(sessionId);
  }

  /** Process one inbound message (serialized per scope). */
  async handleInbound(message: InboundMessage): Promise<void> {
    if (message.unsupportedType !== undefined) {
      const state = this.#stateFor(message);
      this.#logger.info(`unsupported message type: ${message.unsupportedType}`);
      await this.#replyText(state, '这类消息暂不支持。');
      await this.#safeAddReaction(message.messageId, 'CROSS_MARK');
      return;
    }
    // Bot identity may have failed at startup; retry on the next group message
    // before deciding, so a late bot/v3/info success restores normal gating.
    if (message.chatType === 'group' && (this.#transport.getBotOpenId?.() ?? '').length === 0) {
      try {
        await this.#transport.refreshBotOpenId?.();
      } catch (error) {
        this.#logger.warn(`bot identity refresh failed: ${errorMessage(error)}`);
      }
    }
    const botOpenId = this.#transport.getBotOpenId?.();
    const decision = evaluateGate({
      chatType: message.chatType,
      chatId: message.chatId,
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
      senderOpenId: message.senderOpenId,
      text:
        message.text.trim().length === 0 && (message.attachments?.length ?? 0) > 0
          ? '[attachment]'
          : message.text,
      ...(message.mentions === undefined ? {} : { mentions: message.mentions }),
      ...(botOpenId === undefined ? {} : { botOpenId }),
      requireBotIdentity: this.#config.gateRequireBotIdentity !== false,
      allowedChats: this.#config.allowedChats,
      allowedUsers: this.#config.allowedUsers,
    });
    logGate(this.#logger, decision, {
      chatId: message.chatId,
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
      senderOpenId: message.senderOpenId,
    });
    if (!decision.accept && decision.reason === 'bot-identity-unknown') {
      if (!this.#botIdentityErrorLogged) {
        this.#botIdentityErrorLogged = true;
        this.#logger.error(
          'gate: bot identity unknown; group @ messages are rejected until resolved',
        );
      }
    }
    if (!decision.accept) return;
    if (!this.#isAdmin(message.senderOpenId) && !this.#isPublicCommand(message.text)) {
      const state = this.#stateFor(message);
      state.lastInboundMessageId = message.messageId;
      state.ownerOpenId = message.senderOpenId;
      this.#logger.info(
        `gate drop: not-admin sender=${message.senderOpenId.slice(0, 12) || '-'}`,
      );
      await this.#replyText(state, '访客无执行权限。');
      return;
    }
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

  #isAdmin(openId: string): boolean {
    const admins = this.#config.admins ?? [];
    return admins.length === 0 || admins.includes(openId);
  }

  /** `/help` and `/whoami` are safe for any sender (no execution, no session). */
  #isPublicCommand(text: string): boolean {
    const command = parseCommand(text);
    return (
      command.kind === 'help' ||
      command.kind === 'whoami' ||
      (command.kind === 'usage' && (command.command === 'help' || command.command === 'whoami'))
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

    state.logEvents.push(event);
    if (state.logEvents.length > 5000) state.logEvents.shift();
    state.status.apply(event);

    switch (event.type) {
      case 'turn/start': {
        state.running = true;
        state.stopRequested = false;
        state.lastOutput = '';
        state.progress?.dispose();
        state.progress = this.#makeCardStream(state);
        await this.#renderProgress(state);
        break;
      }
      case 'step/start': {
        await this.#renderProgress(state);
        break;
      }
      case 'step/end':
      case 'tool/call':
      case 'tool/result': {
        await this.#renderProgress(state);
        break;
      }
      case 'request/header': {
        // First request header of the session = the exact tool list the model
        // receives. This is the only authoritative tools:count source.
        const data = event.data as
          | { readonly header?: { readonly tools?: readonly unknown[] } }
          | undefined;
        const toolCount = Array.isArray(data?.header?.tools) ? data.header.tools.length : 0;
        state.lastAgentTurn = {
          ...(this.#selfCheck?.presetId() === undefined
            ? {}
            : { preset: this.#selfCheck?.presetId() }),
          toolsCount: toolCount,
          at: event.time ?? this.#now(),
        };
        await this.#maybeSelfCheckTools(state, session, toolCount);
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
      case 'compaction/start':
      case 'compaction/end':
      case 'team/member':
      case 'team/task': {
        await this.#renderProgress(state);
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
    state.ownerOpenId = message.senderOpenId;
    // Startup-stage failures have no session to notify yet; the first message
    // with a session catches up here (once per fail combination).
    await this.#maybeNotifySelfCheck(state);
    const text = message.text.trim();
    if (text.startsWith('/')) {
      await this.#handleSlash(state, message.text);
      return;
    }
    state.reactionQueue.push(message.messageId);
    this.#startReaction(state, message.messageId);
    await this.#deliverTurn(state, {
      text: message.text,
      ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
    });
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
        const checker = this.#selfCheck;
        const selfLine = checker?.statusLine();
        const fails = checker?.failureIds() ?? [];
        const failAt = checker?.lastFailureAt();
        const anomaly =
          fails.length > 0 && failAt !== undefined
            ? `\n最近异常：${fails.join(',')} @ ${sessionTimeLabel(failAt, this.#now())}`
            : '';
        const permissionLine = this.#permissionLineFor(state);
        await this.#replyText(
          state,
          `${selfLine === undefined ? '' : `${selfLine}\n`}${statusText(state.status.get(), {
            ...(title === undefined ? {} : { title }),
            ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
          })}${permissionLine === undefined ? '' : `\n${permissionLine}`}${anomaly}`,
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
      case 'doctor': {
        const provider = this.#options.doctorInputs;
        if (provider === undefined) {
          await this.#replyText(state, '体检未接线（doctorInputs 未注入）。');
          return;
        }
        try {
          const report = await buildDoctorReport(await provider(this.#doctorSessionInfo(state)));
          this.#logger.info(
            `doctor: ${report.counts.normal} ok / ${report.counts.fail} fail / ${report.counts.skip} skip`,
          );
          await this.#replyText(
            state,
            command.json === true ? renderDoctorJson(report) : renderDoctorText(report),
          );
        } catch (error) {
          await this.#replyText(state, `体检生成失败：${errorMessage(error)}`);
        }
        return;
      }
      case 'selfcheck': {
        const checker = this.#options.selfCheck;
        if (checker === undefined) {
          await this.#replyText(state, '自检未接线。');
          return;
        }
        await checker.runAll();
        await this.#maybeNotifySelfCheck(state);
        await this.#replyText(state, checker.detailText());
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
      case 'export': {
        await this.#exportSession(state, command.json === true);
        return;
      }
      case 'permission': {
        await this.#handlePermission(state, command.preset);
        return;
      }
      case 'usage-report': {
        await this.#handleUsage(state);
        return;
      }
      case 'whoami': {
        const openId = state.ownerOpenId ?? '';
        const identity = this.#isAdmin(openId) ? '管理员' : '访客';
        const topic =
          state.threadId === undefined ? '' : `[话题 ${state.threadId}]`;
        await this.#replyText(
          state,
          `你的 open_id：${openId}\n当前会话：${state.chatId}${topic}\n身份：${identity}`,
        );
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

  async #prepareAttachments(
    state: ScopeState,
    input: { readonly text: string; readonly attachments?: readonly InboundAttachment[] },
  ): Promise<{ readonly content: readonly unknown[] } | undefined> {
    const attachments = input.attachments ?? [];
    if (attachments.length === 0) {
      return { content: [{ type: 'text', text: input.text }] };
    }
    const maxBytes = this.#config.maxAttachmentBytes ?? 20 * 1024 * 1024;
    const imagesEnabled = this.#config.images !== false;
    const filesEnabled = this.#config.files !== false;
    const kept: InboundAttachment[] = [];
    let imageCount = 0;
    let truncatedImages = 0;
    let ignored = 0;
    for (const attachment of attachments) {
      if (attachment.kind === 'image') {
        if (!imagesEnabled) {
          ignored += 1;
          continue;
        }
        if (imageCount >= 9) {
          truncatedImages += 1;
          continue;
        }
        imageCount += 1;
        kept.push(attachment);
      } else if (!filesEnabled) {
        ignored += 1;
      } else {
        kept.push(attachment);
      }
    }
    if (ignored > 0) {
      await this.#replyText(state, '当前未启用图片/文件消息，已忽略部分附件。');
    }
    let annotated = input.text;
    if (truncatedImages > 0) {
      annotated += `（图片超过 9 张，已截断 ${truncatedImages} 张）`;
    }
    const store = this.#options.attachmentProvider?.();
    const parts: unknown[] = [];
    for (const attachment of kept) {
      let downloaded: { readonly bytes: Uint8Array; readonly contentType?: string };
      try {
        downloaded = await this.#transport.downloadResource(
          state.lastInboundMessageId ?? '',
          attachment.fileKey,
          attachment.kind,
          maxBytes,
        );
      } catch (error) {
        const tooLarge = errorMessage(error).includes('too large');
        await this.#replyText(
          state,
          tooLarge ? '文件太大，已跳过。' : '附件下载失败，已跳过。',
        );
        await this.#safeAddReaction(state.lastInboundMessageId ?? '', 'CROSS_MARK');
        return undefined;
      }
      if (downloaded.bytes.length > maxBytes) {
        await this.#replyText(state, '文件太大，已跳过。');
        await this.#safeAddReaction(state.lastInboundMessageId ?? '', 'CROSS_MARK');
        return undefined;
      }
      const base64 = Buffer.from(downloaded.bytes).toString('base64');
      if (attachment.kind === 'image') {
        if (store === undefined) {
          await this.#replyText(state, '当前无法处理图片（attachments 服务不可用）。');
          await this.#safeAddReaction(state.lastInboundMessageId ?? '', 'CROSS_MARK');
          return undefined;
        }
        parts.push({
          type: 'image',
          mediaType: imageMediaType(downloaded.contentType),
          data: base64,
          ...(attachment.fileName === undefined ? {} : { name: attachment.fileName }),
        });
        continue;
      }
      const fileName = attachment.fileName ?? attachment.fileKey;
      let admitted = false;
      if (store !== undefined) {
        try {
          const ref = await store.admitEncodedFile({ data: base64, name: fileName });
          parts.push({ type: 'file', attachment: ref });
          admitted = true;
        } catch {
          admitted = false;
        }
      }
      if (!admitted) {
        try {
          const dir = this.#config.defaultCwd;
          mkdirSync(dir, { recursive: true });
          const target = join(dir, `${Date.now()}-${fileName.replace(/[^\w.-]+/g, '_')}`);
          writeFileSync(target, downloaded.bytes);
          annotated += `（文件已保存：${target}）`;
        } catch (error) {
          this.#logger.warn(`attachment file save failed: ${errorMessage(error)}`);
          await this.#replyText(state, '附件保存失败，已跳过。');
          await this.#safeAddReaction(state.lastInboundMessageId ?? '', 'CROSS_MARK');
          return undefined;
        }
      }
    }
    if (parts.length === 0) return { content: [{ type: 'text', text: annotated }] };
    if (store !== undefined) {
      try {
        const admitted = await store.admitPromptContent([
          { type: 'text', text: annotated },
          ...parts,
        ]);
        return { content: admitted };
      } catch (error) {
        this.#logger.warn(`attachment admission failed: ${errorMessage(error)}`);
        await this.#replyText(state, '附件处理失败，已跳过。');
        await this.#safeAddReaction(state.lastInboundMessageId ?? '', 'CROSS_MARK');
        return undefined;
      }
    }
    return { content: [{ type: 'text', text: annotated }, ...parts] };
  }

  async #deliverTurn(
    state: ScopeState,
    input: { readonly text: string; readonly attachments?: readonly InboundAttachment[] },
  ): Promise<void> {
    const prepared = await this.#prepareAttachments(state, input);
    if (prepared === undefined) return;
    const resolved = await this.#tryResolve(state);
    if (resolved === undefined) {
      await this.#replyText(state, '无法创建会话（agents 服务不可用）。');
      return;
    }
    const message = createUserMessage({
      content: prepared.content as never,
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

  /** `/permission`: Chinese overview; switches still go through dsh's command. */
  /** Permission-card button callback: run the same dsh switch, then patch the card. */
  async handlePermissionCardAction(action: CardAction, name: string): Promise<void> {
    const meta = this.#permissionCards.get(action.messageId);
    if (meta === undefined) return;
    const state = this.#states.get(meta.key);
    if (state === undefined) return;
    if (meta.ownerOpenId !== undefined && action.operatorOpenId !== meta.ownerOpenId) {
      this.#logger.warn(
        `permission card ignored for non-owner ${action.operatorOpenId}`,
      );
      return;
    }
    const service = this.#options.permissionPresetsProvider?.();
    const sessionId = state.sessionId;
    if (service === undefined || sessionId === undefined) return;
    if (!service.names.includes(name)) {
      await this.#replyText(
        state,
        t(this.#lang()).unknownPreset(name, service.names.join(', ')),
      );
      return;
    }
    const agent = this.#agents.get(sessionId);
    if (agent === undefined) return;
    const result = await this.#options.runHarnessCommand?.(
      agent,
      `/permission ${name}`,
    );
    if (result === undefined) {
      await this.#replyText(state, '切换失败：dsh 命令未返回结果。');
      return;
    }
    const view = this.#permissionViewFor(state);
    if (view !== undefined) {
      try {
        await this.#transport.updateCard(action.messageId, buildPermissionCard(view));
      } catch (error) {
        this.#logger.warn(`permission card patch failed: ${errorMessage(error)}`);
      }
    }
    await this.#replyText(
      state,
      translatePermissionOutput(result.text, name, this.#lang()),
    );
  }

  /** `/usage`: aggregate durable assistant/message usage from the session log. */
  async #handleUsage(state: ScopeState): Promise<void> {
    const sessionId = state.sessionId ?? this.#sessionMap.get(state.key);
    if (sessionId === undefined) {
      await this.#replyText(state, '读不到会话日志（当前没有会话）');
      return;
    }
    const provider = this.#options.usageProvider;
    if (provider === undefined) {
      await this.#replyText(state, '读不到会话日志（sessionQuery 服务不可用）');
      return;
    }
    let events: readonly unknown[] | undefined;
    try {
      events = await provider(sessionId);
    } catch (error) {
      await this.#replyText(state, `读不到会话日志（${errorMessage(error)}）`);
      return;
    }
    if (events === undefined) {
      await this.#replyText(state, '读不到会话日志（sessionQuery 服务不可用）');
      return;
    }
    const metricsLine = formatMetricsLine(
      aggregateMetrics(events),
      this.#config.metrics ?? 'compact',
    );
    await this.#replyText(
      state,
      renderUsageReport(aggregateUsage(events)) +
        (metricsLine.length === 0 ? '' : `\n${metricsLine}`),
    );
  }

  #lang(): Lang {
    return this.#options.languageProvider?.() ?? 'zh';
  }

  #permissionViewFor(state: ScopeState): PermissionView | undefined {
    const service = this.#options.permissionPresetsProvider?.();
    const sessionId = state.sessionId;
    if (service === undefined || sessionId === undefined) return undefined;
    const agent = this.#agents.get(sessionId);
    if (agent === undefined) return undefined;
    const current = service.current(agent.session);
    const presets = service.names.map((name) => {
      try {
        const spec = service.resolve?.(name);
        return {
          name,
          resolved: spec !== undefined,
          ...(spec?.sandbox === undefined ? {} : { sandbox: String(spec.sandbox) }),
          ...(spec?.approval === undefined ? {} : { approval: String(spec.approval) }),
        };
      } catch {
        return { name, resolved: false };
      }
    });
    return { lang: this.#lang(), current, presets };
  }

  #permissionLineFor(state: ScopeState): string | undefined {
    const view = this.#permissionViewFor(state);
    if (view === undefined) return undefined;
    const current = view.presets.find((preset) => preset.name === view.current);
    const approval = current?.approval ?? '?';
    return t(view.lang).approvalLine(view.current, t(view.lang).approvalLabel(approval));
  }

  async #handlePermission(state: ScopeState, preset: string | undefined): Promise<void> {
    const resolved = await this.#tryResolve(state);
    if (resolved === undefined) {
      await this.#replyText(state, '当前没有可用会话。');
      return;
    }
    const service = this.#options.permissionPresetsProvider?.();
    if (service === undefined) {
      // No service to validate/translate against: keep dsh's original output,
      // explicitly labelled so the user knows it is the upstream text.
      const raw = await this.#runDshCommandLine(
        resolved.agent,
        preset === undefined ? '/permission' : `/permission ${preset}`,
      );
      await this.#replyText(state, `（dsh 原文）\n${raw}`);
      return;
    }
    if (preset === undefined) {
      const view = this.#permissionViewFor(state);
      if (view === undefined) {
        const raw = await this.#runDshCommandLine(resolved.agent, '/permission');
        await this.#replyText(state, `（dsh 原文）\n${raw}`);
        return;
      }
      const card = buildPermissionCard(view);
      try {
        const sent = await this.#sendNewCard(state, card);
        this.#permissionCards.set(sent.messageId, {
          key: state.key,
          ...(state.ownerOpenId === undefined ? {} : { ownerOpenId: state.ownerOpenId }),
        });
      } catch {
        await this.#replyText(state, renderPermissionText(view));
      }
      return;
    }

    if (!service.names.includes(preset)) {
      await this.#replyText(
        state,
        `未知档位 ${preset}，可用：${service.names.join(', ')}`,
      );
      return;
    }

    const result = await this.#options.runHarnessCommand?.(
      resolved.agent,
      `/permission ${preset}`,
    );
    if (result === undefined) {
      await this.#replyText(
        state,
        service === undefined
          ? '（dsh 原文）\n权限服务不可用，dsh 命令未返回结果。'
          : '切换失败：dsh 命令未返回结果。',
      );
      return;
    }
    await this.#replyText(
      state,
      translatePermissionOutput(result.text, preset, this.#lang()),
    );
  }

  async #runDshCommandLine(agent: AgentLike, line: string): Promise<string> {
    const result = await this.#options.runHarnessCommand?.(agent, line);
    return result === undefined
      ? '权限服务不可用，dsh 命令未返回结果。'
      : result.text;
  }

  /** `/export`: write a local markdown/JSONL file and hand it to the MEDIA chain. */
  async #exportSession(state: ScopeState, json: boolean): Promise<void> {
    const sessionId = state.sessionId ?? this.#sessionMap.get(state.key);
    if (sessionId === undefined) {
      await this.#replyText(state, '当前没有可导出的会话。');
      return;
    }
    let data;
    try {
      data = await this.#options.exportProvider?.(sessionId);
      if (data === undefined) data = readSessionLogFile(sessionId);
    } catch (error) {
      await this.#replyText(state, `导出失败：${errorMessage(error)}`);
      return;
    }
    if (data === undefined || (data.messages.length === 0 && data.rawJsonl === undefined)) {
      await this.#replyText(state, '本会话没有可导出的日志。');
      return;
    }
    const extension = json ? 'jsonl' : 'md';
    const content = json
      ? truncateExport(data.rawJsonl ?? renderExportJsonl(data.messages))
      : renderExportMarkdown({
          sessionId,
          ...(state.title === undefined ? {} : { title: state.title }),
          now: this.#now(),
          messages: data.messages,
        });
    let path: string;
    try {
      path = writeExportFile(
        defaultExportCacheDir(),
        this.#scopeKind(state),
        sessionId,
        extension,
        content,
        this.#now(),
      );
    } catch (error) {
      await this.#replyText(state, `导出失败：写入文件失败（${errorMessage(error)}）。`);
      return;
    }
    const label = json ? 'JSONL' : 'markdown';
    await this.#replyText(
      state,
      `MEDIA:${path}\n已导出会话 ${sessionId.slice(0, 8)}（${data.messages.length} 条消息，${label}）。`,
    );
    await this.#sendOutboundMedia(state, [
      { path, name: basename(path), image: false },
    ]);
  }

  async #settleTurn(state: ScopeState, event: StatusEventLike): Promise<void> {
    state.running = false;
    const kind = turnEndReasonKind(event.data);
    const finalState = stateForTurnEnd(kind);
    const finalStateLabel = statusLabel(finalState);
    // The tracker is usually already terminal (apply ran before this method),
    // but re-apply to guarantee /status never disagrees with the final card.
    state.status.apply(event);
    const snapshot = state.status.get();
    const rawBody =
      state.lastOutput.trim().length > 0
        ? state.lastOutput
        : `本轮已结束（${finalStateLabel}）。`;
    const outbound = this.#planOutboundMedia(state, rawBody);
    const body = outbound.body;
    const finalInput = this.#finalCardInput(state, snapshot, body, finalState, finalStateLabel);

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

    await this.#sendOutboundMedia(state, outbound.entries);
    if (shouldNotifyTerminal(kind)) {
      const notice = terminalNotice(kind, snapshot.errorMessage);
      if (notice !== undefined) await this.#replyText(state, notice);
    }
    await this.#finishReactions(state, kind);
    await this.#refreshSessionMetrics(state);
    state.stopRequested = false;
    state.lastOutput = '';
  }

  /** Extract MEDIA markers, validate paths, and annotate the final card body. */
  #planOutboundMedia(
    state: ScopeState,
    rawBody: string,
  ): {
    readonly body: string;
    readonly entries: readonly {
      readonly path: string;
      readonly name: string;
      readonly image: boolean;
    }[];
  } {
    if (this.#config.sendMedia === false) return { body: rawBody, entries: [] };
    const parsed = extractMediaMarkers(rawBody);
    if (parsed.paths.length === 0) return { body: parsed.text, entries: [] };
    const cwd = this.#sessionMap.getCwd(state.key) ?? this.#config.defaultCwd;
    const roots = this.#config.mediaRoots?.length ? this.#config.mediaRoots : [cwd];
    const entries: { path: string; name: string; image: boolean }[] = [];
    const notes: string[] = [];
    for (const path of parsed.paths) {
      const resolved = resolveMedia(path, {
        roots,
        maxFileBytes: this.#config.maxSendFileBytes ?? 30 * 1024 * 1024,
        maxImageBytes: this.#config.maxSendImageBytes ?? 10 * 1024 * 1024,
      });
      if (!resolved.ok) {
        notes.push(`📎 ${resolved.name}：未发送（${resolved.reason}）`);
        continue;
      }
      entries.push({ path: resolved.path, name: resolved.name, image: resolved.image });
      notes.push(`📎 ${resolved.name} × 1`);
    }
    const body = parsed.text.length === 0 ? notes.join('\n') : `${parsed.text}\n\n${notes.join('\n')}`;
    return { body, entries };
  }

  /** Upload and reply each validated file individually; one failure never stops the rest. */
  async #sendOutboundMedia(
    state: ScopeState,
    entries: readonly { readonly path: string; readonly name: string; readonly image: boolean }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const replyTo = state.lastInboundMessageId;
    if (replyTo === undefined) {
      this.#logger.warn('media send skipped: no inbound message to reply to');
      return;
    }
    const threadOptions =
      state.threadId === undefined ? {} : { threadId: state.threadId };
    for (const entry of entries) {
      try {
        const bytes = readFileSync(entry.path);
        if (entry.image) {
          const imageKey = await this.#transport.uploadImage(bytes);
          await this.#transport.reply(
            state.chatId,
            replyTo,
            { kind: 'image', imageKey },
            threadOptions,
          );
        } else {
          const fileKey = await this.#transport.uploadFile(entry.name, bytes);
          await this.#transport.reply(
            state.chatId,
            replyTo,
            { kind: 'file', fileKey, fileName: entry.name },
            threadOptions,
          );
        }
      } catch (error) {
        this.#logger.warn(
          `media send failed for ${entry.name} (${entry.path}): ${errorMessage(error)}`,
        );
      }
    }
  }

  #finalCardInput(
    state: ScopeState,
    snapshot: StatusSnapshot,
    body: string,
    finalState: StatusState,
    finalStateLabel: string,
  ): FinalCardInput {
    const sessionTitle = this.#titleOf(state)?.trim() ?? state.title;
    return {
      title: '飞书会话 · 过程',
      // Event-derived, never the (possibly stale) tracker snapshot.
      stateLabel: finalStateLabel,
      steps: snapshot.steps,
      tools: snapshot.tools,
      ...(sessionTitle === undefined ? {} : { sessionTitle }),
      recentEvent: recentEventText(snapshot),
      ...(snapshot.startedAt === undefined ? {} : { startedAt: snapshot.startedAt }),
      ...(snapshot.endedAt === undefined ? {} : { endedAt: snapshot.endedAt }),
      body,
      template: statusTemplate(finalState),
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

  async #cancelCurrentTurn(
    state: ScopeState,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    const sessionId = state.sessionId ?? this.#sessionMap.get(state.key);
    if (sessionId === undefined) return { ok: false, reason: '本聊天/话题还没有会话。' };
    const agent = this.#agents.get(sessionId);
    if (agent === undefined) return { ok: false, reason: '当前没有在跑的会话。' };
    try {
      agent.cancel({ kind: 'user' });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: `取消失败：${errorMessage(error)}` };
    }
  }

  async #stop(state: ScopeState): Promise<void> {
    const result = await this.#cancelCurrentTurn(state);
    if (!result.ok) {
      await this.#replyText(state, result.reason);
      return;
    }
    await this.#replyText(state, '已停止当前回合。后台任务仍在运行，完成后结果会回来。');
  }

  /** Stop button callback: same cancel path as `/stop`, once per second. */
  async handleStopCardAction(action: CardAction): Promise<void> {
    const key = this.#stopCards.get(action.messageId);
    if (key === undefined) return;
    const state = this.#states.get(key);
    if (state === undefined || !state.running) return;
    const now = this.#now();
    const last = this.#stopClicks.get(action.messageId);
    if (last !== undefined && now - last < 1000) return;
    this.#stopClicks.set(action.messageId, now);

    const result = await this.#cancelCurrentTurn(state);
    if (!result.ok) {
      this.#logger.warn(`stop card failed: ${result.reason}`);
      return;
    }
    state.stopRequested = true;
    if (state.progress?.messageId === action.messageId) {
      await this.#renderProgress(state);
      await state.progress?.flush();
    }
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
      const persistedPreset = this.#sessionPresetLookup?.(target);
      const { agent } = await this.#agents.resume({
        resumeSessionId: target,
        setup: async (agentCtx: unknown) => {
          this.#agentCtxBySession.set(target, agentCtx);
          if (persistedPreset === undefined) await this.#mountPreset(target, agentCtx);
        },
      });
      if (current !== undefined && current !== target) {
        state.previousSessionId = current;
        state.previousSessionAt = this.#lastActivityAt(state) ?? this.#now();
      }
      this.#applyApprovalPolicy(agent);
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
   * Apply the configured session approval policy to a freshly created/resumed
   * agent. Missing service warns once; setPolicy errors never block the turn.
   */
  #applyApprovalPolicy(agent: AgentLike): void {
    const policy = this.#options.approvalPolicy;
    if (policy === undefined) return; // never override dsh's own default
    this.#logger.info(`agent approval policy=${policy}`);
    const provider = this.#options.approvalProvider;
    if (provider === undefined) return;
    const service = provider();
    if (service === undefined) {
      if (!this.#approvalMissingWarned) {
        this.#approvalMissingWarned = true;
        this.#logger.warn('approval service unavailable; session approval policy not applied');
      }
      return;
    }
    try {
      service.setPolicy(agent, policy);
    } catch (error) {
      this.#logger.warn(
        `agent approval policy=${policy} failed: ${errorMessage(error)}`,
      );
    }
  }

  #interactiveContext(sessionId: string):
    | { scopeKey: string; chatId: string; ownerOpenId: string; sessionId: string }
    | undefined {
    const key = this.#scopeBySession.get(sessionId);
    if (key === undefined) return undefined;
    const state = this.#states.get(key);
    if (state === undefined || state.ownerOpenId === undefined) return undefined;
    const permissionLine = this.#permissionLineFor(state);
    return {
      scopeKey: state.key,
      chatId: state.chatId,
      ownerOpenId: state.ownerOpenId,
      sessionId,
      ...(permissionLine === undefined ? {} : { permissionLine }),
    };
  }

  /**
   * Mount the configured agent preset in the unpublished agent scope.
   * Idempotent for resumes: a context that already reports a composed preset is
   * left alone. Failures are contained (the session stays usable) and recorded
   * so the card state line can show `（preset 未挂载）`.
   */
  async #mountPreset(sessionId: string, agentCtx: unknown): Promise<void> {
    // Retained for stage-B self-checks even when mounting fails.
    this.#agentCtxBySession.set(sessionId, agentCtx);
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
    this.#applyApprovalPolicy(agent);
    await this.#runSelfCheckStageB(state, sessionId);
    return { agent };
  }

  /** Stage B runs after every create/resume; logging is de-duplicated inside. */
  async #runSelfCheckStageB(state: ScopeState, sessionId: string): Promise<void> {
    if (this.#selfCheck === undefined) return;
    await this.#selfCheck.runStageB(this.#agentCtxBySession.get(sessionId));
    await this.#maybeNotifySelfCheck(state);
  }

  /**
   * Mirror self-check failures into the conversation (one text, not a card).
   * Deduped by the SORTED fail-id set: same set -> silent; changed set -> new
   * message; back to no failures -> one `✓ 自检已恢复`. Send errors are logged
   * and never retried or propagated.
   */
  async #maybeNotifySelfCheck(state: ScopeState): Promise<void> {
    const checker = this.#selfCheck;
    if (checker === undefined) return;
    const fails = checker.failureIds();
    const signature = fails.join(',');
    if (signature.length > 0) {
      if (signature === this.#selfCheckNotifiedSignature) return;
      this.#selfCheckNotifiedSignature = signature;
      const items = checker
        .failureItems()
        .slice(0, 3)
        .map((item) => `${item.id} — ${item.consequence ?? item.detail}`);
      const extra = fails.length > 3 ? ` 等 ${fails.length - 3} 项` : '';
      const text = `⚠ 自检异常 ${items.join('；')}${extra}（详情 /doctor）`;
      try {
        await this.#replyText(state, text);
      } catch (error) {
        this.#logger.warn(`selfcheck notification failed: ${errorMessage(error)}`);
      }
      return;
    }
    if (this.#selfCheckNotifiedSignature === undefined) return;
    this.#selfCheckNotifiedSignature = undefined;
    this.#logger.info('selfcheck recovered');
    try {
      await this.#replyText(state, '✓ 自检已恢复');
    } catch (error) {
      this.#logger.warn(`selfcheck recovery notification failed: ${errorMessage(error)}`);
    }
  }

  #doctorSessionInfo(state: ScopeState): DoctorSessionInfo {
    const sessionId = state.sessionId ?? this.#sessionMap.get(state.key);
    const preset = this.#selfCheck?.presetId();
    return {
      scopeKey: state.key,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(preset === undefined ? {} : { preset, presetMounted: true }),
      ...(preset === undefined && this.#selfCheck?.presetMounted() === false
        ? { presetMounted: false }
        : {}),
      ...(this.#selfCheck?.toolCount() === undefined
        ? {}
        : { toolsCount: this.#selfCheck.toolCount() }),
      historyLength: this.#sessionMap.history(state.key).length,
      ...(state.lastAgentTurn === undefined ? {} : { lastTurn: state.lastAgentTurn }),
    };
  }

  /** First `request/header` of a session: record the model's actual tool count. */
  async #maybeSelfCheckTools(
    state: ScopeState,
    session: { readonly id: string },
    toolCount: number,
  ): Promise<void> {
    const checker = this.#selfCheck;
    if (checker === undefined) return;
    const sessionId = String(session.id);
    if (this.#toolsCheckedSessions.has(sessionId)) return;
    this.#toolsCheckedSessions.add(sessionId);
    await checker.checkTools(toolCount);
    await this.#maybeNotifySelfCheck(state);
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
        setup: async (agentCtx: unknown) => {
          // Always capture the agent scope for stage-B self-checks; only legacy
          // headers (no persisted preset) actually mount.
          this.#agentCtxBySession.set(sessionId, agentCtx);
          if (persistedPreset === undefined) await this.#mountPreset(sessionId, agentCtx);
        },
      });
      this.#bindSession(state, String(agent.session.id));
      this.#applyApprovalPolicy(agent);
      await this.#runSelfCheckStageB(state, sessionId);
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
    if (state.sessionId !== undefined && state.sessionId !== sessionId) {
      this.#sessionMetrics.delete(state.key);
      this.#metricsFallbackWarned.delete(state.key);
    }
    for (const [id, key] of this.#scopeBySession) {
      if (key === state.key && id !== sessionId) this.#scopeBySession.delete(id);
    }
    this.#scopeBySession.set(sessionId, state.key);
    this.#chatIdBySession.set(sessionId, state.chatId);
    state.sessionId = sessionId;
  }

  /**
   * Send an interactive card the same way process cards go out: reply into the
   * originating topic/thread when the session still has a live scope. Falls
   * back to a chat send only when the scope state is gone.
   */
  async sendInteractiveCard(
    sessionId: string,
    card: FeishuCard,
  ): Promise<{ readonly messageId: string; readonly threadId?: string }> {
    const key = this.#scopeBySession.get(sessionId);
    const state = key === undefined ? undefined : this.#states.get(key);
    if (state === undefined) {
      const chatId = this.#chatIdBySession.get(sessionId) ?? '';
      this.#logger.warn(
        `interactive: no scope state for ${sessionId}; falling back to chat send`,
      );
      return this.#transport.sendCard(chatId, card);
    }
    const sent = await this.#sendNewCard(state, card);
    return {
      ...sent,
      ...(state.threadId === undefined ? {} : { threadId: state.threadId }),
    };
  }

  #startReaction(state: ScopeState, messageId: string): void {
    if (this.#config.reactions === false) return;
    const promise = this.#safeAddReaction(
      messageId,
      this.#config.reactionOnStart ?? 'OnIt',
    );
    state.reactionStarts.set(messageId, promise);
    void promise;
  }

  /** Remove the start reaction, then add the terminal reaction (best effort). */
  async #finishReactions(state: ScopeState, turnKind: string | undefined): Promise<void> {
    if (this.#config.reactions === false) return;
    const messageId = state.reactionQueue.shift();
    if (messageId === undefined) return;
    const start = state.reactionStarts.get(messageId);
    state.reactionStarts.delete(messageId);
    const reactionId = start === undefined ? undefined : await start;
    if (reactionId !== undefined) await this.#safeRemoveReaction(messageId, reactionId);

    const completed = turnKind === 'completed';
    const emoji =
      completed
        ? (this.#config.reactionOnDone ?? 'DONE')
        : (this.#config.reactionOnFail ?? 'CROSS_MARK');
    const added = await this.#safeAddReaction(messageId, emoji);
    if (!completed && added === undefined && emoji !== 'THINKING') {
      await this.#safeAddReaction(messageId, 'THINKING');
    }
  }

  async #safeAddReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    try {
      return await this.#transport.addReaction(messageId, emojiType);
    } catch (error) {
      this.#logReactionSkipped(error);
      return undefined;
    }
  }

  async #safeRemoveReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.#transport.removeReaction(messageId, reactionId);
    } catch (error) {
      this.#logReactionSkipped(error);
    }
  }

  #logReactionSkipped(error: unknown): void {
    const code = (error as { code?: unknown }).code;
    this.#logger.debug(
      `reaction skipped: ${typeof code === 'number' ? code : 'unknown'} ${errorMessage(error)}`,
    );
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
      reactionQueue: [],
      reactionStarts: new Map(),
      logEvents: [],
    };
    this.#states.set(key, created);
    return created;
  }

  #makeCardStream(state: ScopeState): CardStream {
    const channel: CardChannel = {
      create: async (card: FeishuCard) => {
        const sent = await this.#sendNewCard(state, card);
        this.#stopCards.set(sent.messageId, state.key);
        return sent;
      },
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
    // A topic must receive a thread reply; a normal chat must get a plain card
    // message (quoting the user's message creates a fake "topic" UI).
    if (state.threadId !== undefined && state.lastInboundMessageId !== undefined) {
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
    await stream.set(await this.#progressCardFor(state, snapshot));
  }

  /** Full-session metrics for a card; cold cache reads the log once. */
  async #metricsFor(state: ScopeState, snapshot: StatusSnapshot): Promise<ReturnType<typeof aggregateMetrics>> {
    const sessionId = state.sessionId ?? this.#sessionMap.get(state.key);
    if (sessionId === undefined) return aggregateMetrics(state.logEvents);
    let cached = this.#sessionMetrics.get(state.key);
    if (cached === undefined || cached.sessionId !== sessionId) {
      const provider = this.#options.usageProvider;
      if (provider === undefined) {
        if (!this.#metricsFallbackWarned.has(state.key)) {
          this.#metricsFallbackWarned.add(state.key);
          this.#logger.warn('metrics fallback: process buffer');
        }
        return aggregateMetrics(state.logEvents);
      }
      try {
        const events = await provider(sessionId);
        if (events !== undefined) {
          cached = {
            sessionId,
            metrics: aggregateMetrics(events),
            refreshedAtSeq: events.length,
            turn: snapshot.turn,
          };
          this.#sessionMetrics.set(state.key, cached);
        }
      } catch {
        // fall through to the process buffer
      }
      if (cached === undefined || cached.sessionId !== sessionId) {
        if (!this.#metricsFallbackWarned.has(state.key)) {
          this.#metricsFallbackWarned.add(state.key);
          this.#logger.warn('metrics fallback: process buffer');
        }
        return aggregateMetrics(state.logEvents);
      }
    }
    const base = cached.metrics;
    // During a turn whose events are not in the cached snapshot yet, add the
    // in-memory turn delta so numbers move monotonically until turn/end.
    if (!state.running || snapshot.turn <= cached.turn) return base;
    const usage = snapshot.usageTurn;
    const input = base.inputTokens + (usage?.input ?? 0);
    const output = base.outputTokens + (usage?.output ?? 0);
    const cacheRead = base.cacheReadTokens + (usage?.cacheRead ?? 0);
    const denominator = input + cacheRead;
    const elapsed =
      snapshot.startedAt === undefined ? undefined : this.#now() - snapshot.startedAt;
    const tokensPerSecond =
      elapsed !== undefined && elapsed >= 1000 && (usage?.output ?? 0) > 0
        ? (usage?.output ?? 0) / (elapsed / 1000)
        : undefined;
    return {
      rounds: Math.max(base.rounds, snapshot.turn),
      steps: base.steps + snapshot.steps,
      totalTokens: base.totalTokens + (usage?.total ?? 0),
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
      ...(denominator === 0 ? {} : { cacheHitPercent: Math.round((cacheRead / denominator) * 100) }),
      ...(base.contextPercent === undefined ? {} : { contextPercent: base.contextPercent }),
    };
  }

  /** Recompute the full-session metrics once after each turn/end. */
  async #refreshSessionMetrics(state: ScopeState): Promise<void> {
    const sessionId = state.sessionId ?? this.#sessionMap.get(state.key);
    if (sessionId === undefined) return;
    const provider = this.#options.usageProvider;
    if (provider === undefined) return;
    try {
      const events = await provider(sessionId);
      if (events === undefined) return;
      this.#sessionMetrics.set(state.key, {
        sessionId,
        metrics: aggregateMetrics(events),
        refreshedAtSeq: events.length,
        turn: state.status.get().turn,
      });
      this.#metricsFallbackWarned.delete(state.key);
    } catch (error) {
      this.#logger.warn(`metrics refresh failed: ${errorMessage(error)}`);
    }
  }

  async #progressCardFor(state: ScopeState, snapshot: StatusSnapshot): Promise<FeishuCard> {
    const extraLines: string[] = [];
    if (snapshot.compaction === 'running') extraLines.push('上下文压缩中…');
    else if (snapshot.compaction === 'done') {
      extraLines.push(
        snapshot.compactionKept === undefined
          ? '已压缩'
          : `已压缩 · 保留 ${snapshot.compactionKept} 条`,
      );
    } else if (snapshot.compaction === 'failed') extraLines.push('上下文压缩失败');
    if (snapshot.teamLine !== undefined) extraLines.push(snapshot.teamLine);
    const metricsMode = this.#config.metrics ?? 'compact';
    if (metricsMode !== 'off') {
      const metricsLine = formatMetricsLine(await this.#metricsFor(state, snapshot), metricsMode);
      if (metricsLine.length > 0) extraLines.push(metricsLine);
    }
    if (state.stopRequested === true) {
      extraLines.push('已停止当前回合。后台任务仍在运行，完成后结果会回来。');
    }
    return progressCardForSnapshot(
      snapshot,
      state.title,
      recentEventText(snapshot),
      state.lastOutput,
      this.#now(),
      state.sessionId !== undefined && this.#presetFailures.has(state.sessionId),
      extraLines,
      state.running && state.stopRequested !== true,
    );
  }

  async #replyText(state: ScopeState, text: string): Promise<void> {
    if (text.length === 0) return;
    try {
      if (state.threadId !== undefined && state.lastInboundMessageId !== undefined) {
        await this.#transport.reply(
          state.chatId,
          state.lastInboundMessageId,
          { kind: 'text', text },
          { threadId: state.threadId },
        );
      } else {
        // Normal chat: a fresh message, not a quoted "topic reply".
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
  extraLines: readonly string[] = [],
  stopButton = false,
): FeishuCard {
  return progressCard({
    title: '飞书会话 · 过程',
    ...(extraLines.length === 0 ? {} : { extraLines }),
    ...(stopButton ? { stopButton: true } : {}),
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


/** Normalize a resource content-type to one of dsh's accepted image types. */
function imageMediaType(contentType: string | undefined): string {
  const normalized = (contentType ?? '').split(';')[0]?.trim().toLowerCase();
  if (
    normalized === 'image/png' ||
    normalized === 'image/jpeg' ||
    normalized === 'image/webp' ||
    normalized === 'image/gif'
  ) {
    return normalized;
  }
  return 'image/jpeg';
}


function translatePermissionOutput(text: string, requested: string, lang: Lang): string {
  const dict = t(lang);
  const success = /^preset\s+(\S+)\s*$/.exec(text.trim());
  if (success !== null) {
    const name = success[1] as string;
    return dict.switchSucceeded(presetLabel(lang, name), name);
  }
  const unknown = /^unknown preset "([^"]+)" \(available: ([^)]*)\)\s*$/.exec(text.trim());
  if (unknown !== null) {
    return dict.unknownPreset(unknown[1] as string, unknown[2] as string);
  }
  return dict.switchedElsewhere(text);
}
