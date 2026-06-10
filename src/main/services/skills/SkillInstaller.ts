// SkillInstaller — install / uninstall a skill into a target provider's
// skills dir, and detect the live per-target status of an existing entry.
//
// Status semantics:
//   - 'managed':       entry exists and matches the skill's contentPath/hash
//   - 'modified':      mode=copy and content drifted from installedHash
//   - 'missing':       entry does not exist at the provider path
//   - 'wrong-symlink': entry is a symlink pointing somewhere other than contentPath

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  InstalledSkill,
  SkillInstallMode,
  SkillTarget,
  SkillTargetState,
  SkillTargetStatus,
} from '@shared/types';
import { copyDir, linkOrCopy, readlinkAbsolute, unlinkSafe } from './linker';
import { getProvider } from './providers';
import { hashDir } from './SkillHash';
import { ensureLayout, getBackupsRoot } from './SkillLockStore';

function makeError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

export interface InstallOptions {
  mode: SkillInstallMode;
  /** If true, back up any pre-existing entry before overwriting. Default true. */
  backupExisting?: boolean;
  /**
   * Required for mode='bundle-wrapper'. Source id of the bundle that owns
   * the on-disk wrapper. Stored on the resulting SkillTargetState.managedBy.
   */
  managedBy?: string;
}

/**
 * Compute the path inside the target provider's dir for a skill `name`.
 * Pure — does not touch the filesystem.
 */
export function getTargetPath(target: SkillTarget, name: string): string {
  return path.join(getProvider(target).getSkillsDir(), name);
}

/**
 * Install (or repair) a skill into one target. Idempotent if already managed.
 * Returns the new per-target state to store in the lock.
 */
export async function installToTarget(
  skill: Pick<InstalledSkill, 'name' | 'contentPath' | 'contentHash'>,
  target: SkillTarget,
  options: InstallOptions
): Promise<SkillTargetState> {
  const provider = getProvider(target);
  if (!(await provider.isAvailable())) {
    throw makeError('EUNAVAILABLE_TARGET', `Target ${target} is not writable`);
  }

  // Bundle-wrapper mode: the wrapper at dst is owned by an external installer
  // (e.g. gstack setup). We never write FS — we only register the state and
  // probe whether the expected wrapper layout is actually present.
  if (options.mode === 'bundle-wrapper') {
    if (!options.managedBy) {
      throw makeError('EINVAL', 'bundle-wrapper install requires managedBy (bundle sourceId)');
    }
    const dst = getTargetPath(target, skill.name);
    const status = await probeBundleWrapperStatus(dst, skill.contentPath);
    return {
      mode: 'bundle-wrapper',
      path: dst,
      status,
      installedAt: new Date().toISOString(),
      managedBy: options.managedBy,
    };
  }

  const dst = getTargetPath(target, skill.name);
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });

  // Inspect what's currently at dst
  const existing = await peekTarget(dst);

  if (
    existing.kind === 'managed-symlink' &&
    existing.resolved === path.resolve(skill.contentPath)
  ) {
    // Already correctly symlinked to our contentPath — idempotent success
    return {
      mode: 'symlink',
      path: dst,
      status: 'managed',
      installedAt: new Date().toISOString(),
    };
  }

  // In-place case: contentPath IS the target path (real-dir native skill that was
  // promoted to a local source pointing at its own provider dir). Don't try to
  // symlink/copy a path into itself — just record the state.
  if (path.resolve(skill.contentPath) === path.resolve(dst)) {
    return {
      mode: options.mode,
      path: dst,
      status: 'managed',
      installedAt: new Date().toISOString(),
      installedHash: options.mode === 'copy' ? skill.contentHash : undefined,
    };
  }

  if (existing.kind !== 'missing' && options.backupExisting !== false) {
    await backupEntry(dst, skill.name);
  } else if (existing.kind !== 'missing') {
    await unlinkSafe(dst);
  }

  let appliedMode: SkillInstallMode;
  let installedHash: string | undefined;
  if (options.mode === 'symlink') {
    appliedMode = await linkOrCopy(skill.contentPath, dst);
  } else {
    await copyDir(skill.contentPath, dst);
    appliedMode = 'copy';
    installedHash = skill.contentHash;
  }

  return {
    mode: appliedMode,
    path: dst,
    status: 'managed',
    installedAt: new Date().toISOString(),
    installedHash,
  };
}

export interface UninstallOptions {
  /**
   * When true, do not touch the on-disk entry at the target path. Used for
   * mode='bundle-wrapper' uninstall — the wrapper is owned by the bundle's
   * installer (e.g. gstack), so we only drop the lock row.
   */
  preserveFs?: boolean;
}

/**
 * Remove the target entry. No-op if missing.
 * Does NOT touch skill.contentPath — that's the responsibility of GatewayManager
 * (and only for 'git' source skills; 'local' sources must never have their
 * contentPath deleted).
 */
export async function uninstallFromTarget(
  target: SkillTarget,
  name: string,
  options: UninstallOptions = {}
): Promise<void> {
  if (options.preserveFs) return;
  await unlinkSafe(getTargetPath(target, name));
}

/**
 * Inspect a target entry and report its live status against the recorded
 * SkillTargetState. Does not mutate anything.
 */
export async function checkTargetStatus(
  skill: Pick<InstalledSkill, 'name' | 'contentPath'>,
  state: SkillTargetState
): Promise<SkillTargetStatus> {
  if (state.mode === 'bundle-wrapper') {
    return probeBundleWrapperStatus(state.path, skill.contentPath);
  }

  const existing = await peekTarget(state.path);
  if (existing.kind === 'missing') return 'missing';

  if (state.mode === 'symlink') {
    if (existing.kind !== 'managed-symlink') return 'wrong-symlink';
    return existing.resolved === path.resolve(skill.contentPath) ? 'managed' : 'wrong-symlink';
  }

  // Copy mode — compare hash if we have one
  if (existing.kind !== 'directory') return 'wrong-symlink';
  if (!state.installedHash) return 'managed';
  try {
    const liveHash = await hashDir(state.path);
    return liveHash === state.installedHash ? 'managed' : 'modified';
  } catch {
    return 'missing';
  }
}

/**
 * Probe whether `wrapperPath` is a valid bundle-installer wrapper pointing at
 * `contentPath` (the bundle sub-skill on disk). Two accepted layouts:
 *   1. wrapperPath is a directory-level symlink → contentPath
 *   2. wrapperPath is a real directory whose `SKILL.md` is a file-symlink
 *      → contentPath/SKILL.md  (gstack's convention)
 *
 * Returns 'bundle-managed' when either layout matches, 'missing' when the
 * wrapper does not exist, 'wrong-symlink' otherwise.
 */
async function probeBundleWrapperStatus(
  wrapperPath: string,
  contentPath: string
): Promise<SkillTargetStatus> {
  const peek = await peekTarget(wrapperPath);
  if (peek.kind === 'missing') return 'missing';
  const contentAbs = path.resolve(contentPath);

  if (peek.kind === 'managed-symlink') {
    return peek.resolved === contentAbs ? 'bundle-managed' : 'wrong-symlink';
  }

  if (peek.kind === 'directory') {
    const skillMdPath = path.join(wrapperPath, 'SKILL.md');
    const altPath = path.join(wrapperPath, 'skill.md');
    const resolved = (await readlinkAbsolute(skillMdPath)) ?? (await readlinkAbsolute(altPath));
    if (!resolved) return 'wrong-symlink';
    const expected = path.join(contentAbs, 'SKILL.md');
    const expectedAlt = path.join(contentAbs, 'skill.md');
    return resolved === expected || resolved === expectedAlt ? 'bundle-managed' : 'wrong-symlink';
  }

  return 'wrong-symlink';
}

// ----- internals -----

type Peek =
  | { kind: 'missing' }
  | { kind: 'managed-symlink'; resolved: string }
  | { kind: 'directory' }
  | { kind: 'file' };

async function peekTarget(dst: string): Promise<Peek> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  if (stat.isSymbolicLink()) {
    const resolved = await readlinkAbsolute(dst);
    return { kind: 'managed-symlink', resolved: resolved ?? '' };
  }
  if (stat.isDirectory()) return { kind: 'directory' };
  return { kind: 'file' };
}

async function backupEntry(src: string, name: string): Promise<void> {
  await ensureLayout();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = getBackupsRoot();
  await fs.promises.mkdir(backupRoot, { recursive: true });
  const target = path.join(backupRoot, `${name}-${ts}`);

  // For symlinks, record the symlink itself (cheap, preserves user state)
  // For directories, move them in (faster than copy)
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(src);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    const linkTarget = await fs.promises.readlink(src);
    await fs.promises.symlink(linkTarget, target, 'dir').catch(async () => {
      await fs.promises.writeFile(`${target}.link`, linkTarget);
    });
    await unlinkSafe(src);
  } else {
    await fs.promises.rename(src, target).catch(async (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fs.promises.cp(src, target, { recursive: true });
      await fs.promises.rm(src, { recursive: true, force: true });
    });
  }
}
