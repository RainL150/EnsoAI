// Low-level link / copy / unlink helpers used by SkillInstaller.
// Default: symlink (cheap, single source of truth).
// Windows fallback: recursive copy when symlinks need admin privileges.

import * as fs from 'node:fs';
import * as path from 'node:path';

export type LinkMode = 'symlink' | 'copy';

/** Create a symlink (preferred) or recursive copy (fallback) at `dst`. */
export async function linkOrCopy(src: string, dst: string): Promise<LinkMode> {
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fs.promises.symlink(src, dst, 'dir');
    return 'symlink';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
      await fs.promises.cp(src, dst, { recursive: true, errorOnExist: true });
      return 'copy';
    }
    throw err;
  }
}

/** Force-create a copy (skip symlink attempt). */
export async function copyDir(src: string, dst: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  await fs.promises.cp(src, dst, { recursive: true, errorOnExist: true });
}

/** Remove an entry — handles symlink / dir / missing without throwing. */
export async function unlinkSafe(dst: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    await fs.promises.unlink(dst);
    return;
  }
  if (stat.isDirectory()) {
    await fs.promises.rm(dst, { recursive: true, force: true });
    return;
  }
  await fs.promises.unlink(dst);
}

/** Resolve a symlink's absolute target. Returns null if dst is not a symlink. */
export async function readlinkAbsolute(dst: string): Promise<string | null> {
  try {
    const stat = await fs.promises.lstat(dst);
    if (!stat.isSymbolicLink()) return null;
    const target = await fs.promises.readlink(dst);
    return path.isAbsolute(target) ? target : path.resolve(path.dirname(dst), target);
  } catch {
    return null;
  }
}
