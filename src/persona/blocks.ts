/**
 * The single dsh-caduceus block inside the user-global `AGENTS.md` (design doc
 * §4): SOUL personality material is synced into
 *
 * ```md
 * <!-- dsh-caduceus:soul:start -->
 * …SOUL.md body…
 * <!-- dsh-caduceus:soul:end -->
 * ```
 *
 * Invariants:
 * - nothing outside the two markers is ever touched — byte for byte;
 * - the operation is idempotent: identical content is not written;
 * - a missing SOUL source or an unreadable/malformed target returns a status,
 *   it never throws (a broken persona must not take the service down).
 *
 * The default target is `$DSH_HOME/AGENTS.md` — the single user-global
 * instruction file that `@deepseek-ai/dsh-agent-instructions` actually reads.
 * (Older builds wrote `$DSH_AGENTS_HOME/AGENTS.md`, which dsh never loads;
 * that legacy location is only detected and reported, never written.)
 * The default source is tried in order: `$DSH_HOME/SOUL.md`, then
 * `$DSH_AGENTS_HOME/SOUL.md` (normally `~/.agents/SOUL.md`). When no candidate
 * exists the sync is a no-op: status `missing`, one info log line
 * `persona source missing`, and neither file is created or modified.
 *
 * @module @artomyuan/dsh-caduceus/persona/blocks
 */
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../atomic-write.js';
import {
  defaultAgentsFile,
  defaultSoulCandidatePaths,
  legacyAgentsFile,
  type HomeEnv,
} from '../home.js';
import { silentLogger, type LoggerLike } from '../logger.js';

/** Opening marker, matched literally. */
export const SOUL_START_MARKER = '<!-- dsh-caduceus:soul:start -->';
/** Closing marker, matched literally. */
export const SOUL_END_MARKER = '<!-- dsh-caduceus:soul:end -->';

/**
 * Recommended ceiling for the soul body. `AGENTS.md` shares one byte budget
 * across all instruction roots and over-budget content is truncated silently
 * from the head, so the persona block must stay small (design doc §4).
 */
export const SOUL_RECOMMENDED_MAX_BYTES = 2 * 1024;

/** Result of scanning a document for the soul block. */
export type SoulBlockInspection =
  | { readonly status: 'absent' }
  | { readonly status: 'present'; readonly content: string }
  | { readonly status: 'malformed'; readonly reason: string };

/** Result of the pure upsert. */
export type SoulUpsertResult =
  | {
      readonly status: 'insert' | 'replace' | 'none';
      readonly content: string;
      readonly warnings: readonly string[];
    }
  | { readonly status: 'malformed-target'; readonly reason: string }
  | { readonly status: 'invalid-soul'; readonly reason: string };

export interface SoulPaths {
  /**
   * Explicit SOUL source file. When omitted, the default candidates are tried
   * in order: `<DSH_HOME>/SOUL.md` then `<DSH_AGENTS_HOME>/SOUL.md`.
   */
  readonly soulFile?: string;
  /** AGENTS.md target file; defaults to `<DSH_HOME>/AGENTS.md`. */
  readonly agentsFile?: string;
  /** Environment used only to resolve default paths. */
  readonly env?: HomeEnv;
  /** Optional logger for the one-line "persona source missing" info record. */
  readonly logger?: LoggerLike;
}

/** Sync outcome, as reported to `/persona sync` and by tests. */
export type SoulSyncStatus = 'created' | 'updated' | 'unchanged' | 'missing' | 'malformed' | 'invalid';

export interface SoulSyncResult {
  readonly status: SoulSyncStatus;
  readonly soulFile: string;
  readonly agentsFile: string;
  /** UTF-8 byte size of the normalized soul body (0 when missing). */
  readonly soulBytes: number;
  /** UTF-8 byte size of the AGENTS.md file after the operation (0 when absent). */
  readonly agentsBytes: number;
  readonly warnings: readonly string[];
  /** Human-readable detail for `missing` / `malformed` / `invalid`. */
  readonly reason?: string;
  /** Candidate source paths that were tried, in order (diagnostics/tests). */
  readonly tried?: readonly string[];
  /** Whether the target `AGENTS.md` exists after the operation. */
  readonly agentsExists?: boolean;
  /** Legacy `<DSH_AGENTS_HOME>/AGENTS.md` that still contains our block, if any. */
  readonly legacyFile?: string;
}

/** Read outcome for `/persona show`. */
export interface SoulReadResult {
  readonly status: 'missing' | 'absent' | 'present' | 'malformed';
  readonly soulFile: string;
  readonly agentsFile: string;
  readonly content?: string;
  readonly soulBytes?: number;
  readonly agentsBytes?: number;
  readonly warnings: readonly string[];
  readonly reason?: string;
  /** Whether the target `AGENTS.md` exists (false for ENOENT). */
  readonly agentsExists: boolean;
  /** Legacy `<DSH_AGENTS_HOME>/AGENTS.md` that still contains our block, if any. */
  readonly legacyFile?: string;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Scan `text` for exactly one soul block.
 *
 * `malformed` is returned for a lone marker, a closing-before-opening pair, or
 * duplicate markers — the caller must not guess, because a wrong guess would
 * rewrite bytes outside the block.
 */
export function inspectSoulBlock(text: string): SoulBlockInspection {
  const startCount = countOccurrences(text, SOUL_START_MARKER);
  const endCount = countOccurrences(text, SOUL_END_MARKER);
  if (startCount === 0 && endCount === 0) return { status: 'absent' };
  if (startCount !== 1 || endCount !== 1) {
    return {
      status: 'malformed',
      reason: `expected exactly one marker pair, found ${startCount} start / ${endCount} end marker(s)`,
    };
  }
  const start = text.indexOf(SOUL_START_MARKER);
  const end = text.indexOf(SOUL_END_MARKER);
  if (end < start) return { status: 'malformed', reason: 'soul end marker precedes the start marker' };
  return {
    status: 'present',
    content: text.slice(start + SOUL_START_MARKER.length, end),
  };
}

/**
 * Render the canonical block for a prepared soul body.
 * Present blocks are `START "\n" body "\n" END`; an empty body renders as
 * `START "\n" END`.
 */
export function renderSoulBlock(body: string): string {
  return body.length === 0
    ? `${SOUL_START_MARKER}\n${SOUL_END_MARKER}`
    : `${SOUL_START_MARKER}\n${body}\n${SOUL_END_MARKER}`;
}

/**
 * Pure, idempotent upsert of the soul block.
 *
 * With an absent pair the block is appended at the end of `existing`; with a
 * present pair only the bytes between the markers are replaced. The function is
 * pure: it neither reads nor writes files.
 */
export function upsertSoulBlock(existing: string, soul: string): SoulUpsertResult {
  const body = soul.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (body.includes(SOUL_START_MARKER) || body.includes(SOUL_END_MARKER)) {
    return {
      status: 'invalid-soul',
      reason: 'SOUL source itself contains a dsh-caduceus soul marker; refusing to nest blocks',
    };
  }
  const warnings: string[] = [];
  const soulBytes = Buffer.byteLength(body, 'utf8');
  if (soulBytes > SOUL_RECOMMENDED_MAX_BYTES) {
    warnings.push(
      `soul body is ${soulBytes} bytes, above the recommended ${SOUL_RECOMMENDED_MAX_BYTES}-byte instruction budget; dsh may truncate it`,
    );
  }

  const inspection = inspectSoulBlock(existing);
  if (inspection.status === 'malformed') return { status: 'malformed-target', reason: inspection.reason };
  if (inspection.status === 'present') {
    const start = existing.indexOf(SOUL_START_MARKER);
    const end = existing.indexOf(SOUL_END_MARKER);
    const content =
      existing.slice(0, start) + renderSoulBlock(body) + existing.slice(end + SOUL_END_MARKER.length);
    return { status: content === existing ? 'none' : 'replace', content, warnings };
  }

  const block = renderSoulBlock(body);
  if (existing.length === 0) {
    return { status: 'insert', content: `${block}\n`, warnings };
  }
  const separator = existing.endsWith('\n') ? '' : '\n';
  return { status: 'insert', content: `${existing}${separator}${block}\n`, warnings };
}

/**
 * Detect the old target location (`<DSH_AGENTS_HOME>/AGENTS.md`) containing our
 * block. This is read-only: the legacy file is never modified or deleted; the
 * caller only reports it in logs and `/persona`.
 */
export async function findLegacySoulBlock(
  paths: SoulPaths = {},
): Promise<string | undefined> {
  const target = paths.agentsFile ?? defaultAgentsFile(paths.env);
  const legacy = legacyAgentsFile(paths.env);
  if (legacy === target) return undefined;
  try {
    const text = await readFile(legacy, 'utf8');
    if (inspectSoulBlock(text).status !== 'absent') {
      (paths.logger ?? silentLogger()).warn(
        `legacy soul block found at ${legacy}; this file is no longer written by caduceus and may be deleted`,
      );
      return legacy;
    }
  } catch {
    // Missing/unreadable legacy file: nothing to report.
  }
  return undefined;
}

/**
 * Sync `<soulFile>` into the soul block of `<agentsFile>`.
 *
 * Never throws for filesystem problems: missing/source errors map to `missing`,
 * a malformed target maps to `malformed`, and a source that would nest markers
 * maps to `invalid`. A missing target file is created.
 */
export async function syncSoul(paths: SoulPaths = {}): Promise<SoulSyncResult> {
  const agentsFile = paths.agentsFile ?? defaultAgentsFile(paths.env);
  const candidates =
    paths.soulFile === undefined ? defaultSoulCandidatePaths(paths.env) : [paths.soulFile];
  const tried: string[] = [];
  let soulFile: string = candidates[0] as string;
  let soulText: string | undefined;

  for (const candidate of candidates) {
    tried.push(candidate);
    try {
      soulText = await readFile(candidate, 'utf8');
      soulFile = candidate;
      break;
    } catch (error) {
      if (!isNotFound(error)) {
        return {
          status: 'missing',
          soulFile: candidate,
          agentsFile,
          soulBytes: 0,
          agentsBytes: 0,
          warnings: [],
          reason: `soul source unavailable (${candidate}): ${errorMessage(error)}`,
          tried,
          agentsExists: false,
        };
      }
      // Not found: fall through to the next candidate.
    }
  }

  if (soulText === undefined) {
    (paths.logger ?? silentLogger()).info(
      `persona source missing (tried ${tried.join(', ')})`,
    );
    return {
      status: 'missing',
      soulFile,
      agentsFile,
      soulBytes: 0,
      agentsBytes: 0,
      warnings: [],
      reason: `soul source unavailable; tried ${tried.join(', ')}`,
      tried,
      agentsExists: false,
    };
  }

  const legacyFile = await findLegacySoulBlock({ ...paths, agentsFile });
  const base = {
    soulFile,
    agentsFile,
    soulBytes: 0,
    agentsBytes: 0,
    tried,
    legacyFile,
    agentsExists: true,
  } as const;

  let exists = true;
  let existing = '';
  try {
    existing = await readFile(agentsFile, 'utf8');
  } catch (error) {
    if (!isNotFound(error)) {
      return {
        ...base,
        status: 'missing',
        warnings: [],
        reason: `AGENTS.md unavailable (${agentsFile}): ${errorMessage(error)}`,
      };
    }
    exists = false;
  }
  const agentsExists = exists;

  const upserted = upsertSoulBlock(existing, soulText);
  if (upserted.status === 'malformed-target') {
    return {
      ...base,
      status: 'malformed',
      warnings: [],
      reason: `${agentsFile}: ${upserted.reason}`,
    };
  }
  if (upserted.status === 'invalid-soul') {
    return {
      ...base,
      status: 'invalid',
      warnings: [],
      reason: upserted.reason,
    };
  }

  const soulBytes = Buffer.byteLength(soulText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim(), 'utf8');
  if (upserted.status === 'none') {
    return {
      ...base,
      status: 'unchanged',
      soulBytes,
      agentsBytes: Buffer.byteLength(existing, 'utf8'),
      warnings: upserted.warnings,
      agentsExists: true,
    };
  }

  await writeFileAtomic(agentsFile, upserted.content);
  return {
    ...base,
    status: exists ? 'updated' : 'created',
    soulBytes,
    agentsBytes: Buffer.byteLength(upserted.content, 'utf8'),
    warnings: upserted.warnings,
    agentsExists,
  };
}

/**
 * Read the currently rendered soul block (for `/persona show`). Never throws:
 * a missing AGENTS.md reports `missing`, an absent block reports `absent`.
 */
export async function readSoul(paths: SoulPaths = {}): Promise<SoulReadResult> {
  const agentsFile = paths.agentsFile ?? defaultAgentsFile(paths.env);
  const candidates =
    paths.soulFile === undefined ? defaultSoulCandidatePaths(paths.env) : [paths.soulFile];
  const warnings: string[] = [];
  const legacyFile = await findLegacySoulBlock({ ...paths, agentsFile });

  let soulFile: string = candidates[0] as string;
  let soulBytes: number | undefined;
  for (const candidate of candidates) {
    try {
      const soulText = await readFile(candidate, 'utf8');
      soulFile = candidate;
      soulBytes = Buffer.byteLength(
        soulText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim(),
        'utf8',
      );
      break;
    } catch {
      // A missing SOUL source is reported by sync; show only needs AGENTS.md.
    }
  }

  let text: string;
  try {
    text = await readFile(agentsFile, 'utf8');
  } catch (error) {
    return {
      status: 'missing',
      soulFile,
      agentsFile,
      ...(soulBytes === undefined ? {} : { soulBytes }),
      warnings,
      reason: `AGENTS.md unavailable (${agentsFile}): ${errorMessage(error)}`,
      agentsExists: false,
      ...(legacyFile === undefined ? {} : { legacyFile }),
    };
  }

  const inspection = inspectSoulBlock(text);
  if (inspection.status === 'absent') {
    return {
      status: 'absent',
      soulFile,
      agentsFile,
      ...(soulBytes === undefined ? {} : { soulBytes }),
      agentsBytes: Buffer.byteLength(text, 'utf8'),
      warnings,
      agentsExists: true,
      ...(legacyFile === undefined ? {} : { legacyFile }),
    };
  }
  if (inspection.status === 'malformed') {
    return {
      status: 'malformed',
      soulFile,
      agentsFile,
      ...(soulBytes === undefined ? {} : { soulBytes }),
      agentsBytes: Buffer.byteLength(text, 'utf8'),
      warnings,
      reason: inspection.reason,
      agentsExists: true,
      ...(legacyFile === undefined ? {} : { legacyFile }),
    };
  }
  return {
    status: 'present',
    soulFile,
    agentsFile,
    content: inspection.content.trim(),
    ...(soulBytes === undefined ? {} : { soulBytes }),
    agentsBytes: Buffer.byteLength(text, 'utf8'),
    warnings,
    agentsExists: true,
    ...(legacyFile === undefined ? {} : { legacyFile }),
  };
}
