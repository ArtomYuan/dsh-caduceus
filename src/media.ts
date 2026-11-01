/**
 * `MEDIA:<absolute path>` markers in the agent's final answer, plus the safety
 * boundary for sending local files back to Feishu.
 *
 * @module dsh-caduceus/media
 */
import { realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, sep } from 'node:path';

export interface MediaMarkerResult {
  /** Answer text with every MEDIA marker line removed. */
  readonly text: string;
  /** Absolute paths in marker order. */
  readonly paths: string[];
}

const MEDIA_LINE = /^\s*MEDIA:(\S.*?)\s*$/;

/** Strip one-line `MEDIA:/abs/path` markers; other lines stay untouched. */
export function extractMediaMarkers(text: string): MediaMarkerResult {
  const kept: string[] = [];
  const paths: string[] = [];
  for (const line of text.split('\n')) {
    const match = MEDIA_LINE.exec(line);
    if (match !== null) {
      const path = (match[1] as string).trim();
      if (path.length > 0) paths.push(path);
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join('\n').trim(), paths };
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

export interface MediaLimits {
  readonly roots: readonly string[];
  readonly maxFileBytes: number;
  readonly maxImageBytes: number;
}

export type MediaResolution =
  | {
      readonly ok: true;
      readonly path: string;
      readonly name: string;
      readonly bytes: number;
      readonly image: boolean;
    }
  | { readonly ok: false; readonly name: string; readonly reason: string };

/** Resolve and validate one marker path (absolute, inside roots, size limit). */
export function resolveMedia(path: string, limits: MediaLimits): MediaResolution {
  const name = basename(path) || path;
  if (!isAbsolute(path)) return { ok: false, name, reason: '仅支持绝对路径' };
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, name, reason: '文件不存在' };
  }
  const realRoots: string[] = [];
  for (const root of limits.roots) {
    try {
      realRoots.push(realpathSync(root));
    } catch {
      // A missing root simply cannot authorize anything.
    }
  }
  const inside = realRoots.some(
    (root) => real === root || real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`),
  );
  if (!inside) return { ok: false, name, reason: '路径不在允许目录内' };
  let stat;
  try {
    stat = statSync(real);
  } catch {
    return { ok: false, name, reason: '文件不存在' };
  }
  if (!stat.isFile()) return { ok: false, name, reason: '不是普通文件' };
  const image = isImagePath(real);
  const max = image ? limits.maxImageBytes : limits.maxFileBytes;
  if (stat.size > max) return { ok: false, name, reason: '超过大小限制' };
  return { ok: true, path: real, name, bytes: stat.size, image };
}
