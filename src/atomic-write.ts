/**
 * Small atomic-write helper shared by the session map and the persona block.
 *
 * Both files must survive a crash between "open" and "close": write the whole
 * payload to a sibling temporary file, then rename it over the target. Rename
 * is atomic on POSIX, so readers see either the old or the new file, never a
 * torn one.
 *
 * @module dsh-caduceus/atomic-write
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The sibling temporary path used before the rename. */
export function temporaryPathFor(filePath: string): string {
  return `${filePath}.tmp`;
}

/** Synchronous flavour (session store: small, called from sync code paths). */
export function writeFileAtomicSync(filePath: string, data: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = temporaryPathFor(filePath);
  try {
    writeFileSync(tempPath, data, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/** Asynchronous flavour (persona sync: called from async command handlers). */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = temporaryPathFor(filePath);
  try {
    await writeFile(tempPath, data, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
