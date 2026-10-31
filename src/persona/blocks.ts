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
 * The default target is `$DSH_AGENTS_HOME/AGENTS.md` (`~/.agents/AGENTS.md` by
 * default) and the default source is `$DSH_HOME/SOUL.md`.
 *
 * @module @artomyuan/dsh-caduceus/persona/blocks
 */
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../atomic-write.js';
import { defaultAgentsFile, defaultSoulPath, type HomeEnv } from '../home.js';

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
  /** SOUL source file; defaults to `<DSH_HOME>/SOUL.md`. */
  readonly soulFile?: string;
  /** AGENTS.md target file; defaults to `<DSH_AGENTS_HOME>/AGENTS.md`. */
  readonly agentsFile?: string;
  /** Environment used only to resolve default paths. */
  readonly env?: HomeEnv;
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
 * Sync `<soulFile>` into the soul block of `<agentsFile>`.
 *
 * Never throws for filesystem problems: missing/source errors map to `missing`,
 * a malformed target maps to `malformed`, and a source that would nest markers
 * maps to `invalid`. A missing target file is created.
 */
export async function syncSoul(paths: SoulPaths = {}): Promise<SoulSyncResult> {
  const soulFile = paths.soulFile ?? defaultSoulPath(paths.env);
  const agentsFile = paths.agentsFile ?? defaultAgentsFile(paths.env);
  const base = { soulFile, agentsFile, soulBytes: 0, agentsBytes: 0 } as const;

  let soulText: string;
  try {
    soulText = await readFile(soulFile, 'utf8');
  } catch (error) {
    return {
      ...base,
      status: 'missing',
      warnings: [],
      reason: `soul source unavailable (${soulFile}): ${errorMessage(error)}`,
    };
  }

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
    };
  }

  await writeFileAtomic(agentsFile, upserted.content);
  return {
    ...base,
    status: exists ? 'updated' : 'created',
    soulBytes,
    agentsBytes: Buffer.byteLength(upserted.content, 'utf8'),
    warnings: upserted.warnings,
  };
}

/**
 * Read the currently rendered soul block (for `/persona show`). Never throws:
 * a missing AGENTS.md reports `missing`, an absent block reports `absent`.
 */
export async function readSoul(paths: SoulPaths = {}): Promise<SoulReadResult> {
  const soulFile = paths.soulFile ?? defaultSoulPath(paths.env);
  const agentsFile = paths.agentsFile ?? defaultAgentsFile(paths.env);
  const warnings: string[] = [];

  let soulBytes: number | undefined;
  try {
    const soulText = await readFile(soulFile, 'utf8');
    soulBytes = Buffer.byteLength(soulText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim(), 'utf8');
  } catch {
    // A missing SOUL source is reported by sync; show only needs AGENTS.md.
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
  };
}
