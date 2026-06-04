// Top-level orchestrator. Ties Sources / Repository / Installer / Lock together.
// All write ops go through the WriteQueue to serialize lock-file mutations.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AvailableSkill,
  DeleteNativeOptions,
  DiscoveredSkill,
  InstalledSkill,
  InstallSkillRequest,
  MirrorDiscoveredRequest,
  PromoteDiscoveredRequest,
  SkillInstallMode,
  SkillSource,
  SkillTarget,
  UninstallSkillOptions,
  UnpromoteRequest,
  UpdateAvailableInfo,
} from '@shared/types';
import { CLAUDE_NATIVE_SOURCE_ID, CODEX_NATIVE_SOURCE_ID } from '@shared/types';
import { shell } from 'electron';
import { copyDir, linkOrCopy, readlinkAbsolute, unlinkSafe } from './linker';
import { getProvider } from './providers';
import { findDiscovered, listAllDiscovered } from './SkillDiscovery';
import {
  checkTargetStatus,
  getTargetPath,
  installToTarget,
  uninstallFromTarget,
} from './SkillInstaller';
import {
  ensureLayout,
  generateSourceId,
  getCanonicalContentRoot,
  getSourcesCacheRoot,
  readLock,
  writeLock,
} from './SkillLockStore';
import { migrateV1IfNeeded } from './SkillMigration';
import { scanSource } from './SkillRepository';
import { SkillScheduler } from './SkillScheduler';
import { WriteQueue } from './writeQueue';

type SkillsListener = (skills: InstalledSkill[]) => void;
type UpdatesListener = (updates: UpdateAvailableInfo[]) => void;

function makeError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function composeSkillId(sourceId: string, name: string): string {
  return `${sourceId}::${name}`;
}

export class SkillGatewayManager {
  private skillsListeners = new Set<SkillsListener>();
  private updateListeners = new Set<UpdatesListener>();
  private writeQueue = new WriteQueue();
  private scheduler: SkillScheduler | null = null;

  subscribe(listener: SkillsListener): () => void {
    this.skillsListeners.add(listener);
    return () => this.skillsListeners.delete(listener);
  }

  subscribeUpdates(listener: UpdatesListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  /**
   * One-shot startup hook. Ensures the on-disk layout exists and runs the
   * v1→v2 migration if a legacy `_index.json` is present. Safe to call
   * multiple times; the migration self-guards on idempotency.
   */
  async init(): Promise<void> {
    await ensureLayout();
    await this.ensureNativeSources();
    try {
      const result = await migrateV1IfNeeded();
      if (result.migrated) {
        console.log(
          '[SkillGateway] v1→v2 migration done:',
          `${result.sourcesCreated} sources, ${result.skillsCreated} skills,`,
          `${result.warnings.length} warnings`
        );
        if (result.warnings.length > 0) {
          for (const w of result.warnings) console.warn('[SkillGateway] migration warning:', w);
        }
        const lock = await readLock();
        this.notify(lock.skills);
      }
    } catch (err) {
      console.warn('[SkillGateway] migration failed:', err);
    }

    // Refresh per-target status so the UI shows the actual state from boot.
    this.checkAllStatuses().catch((err) => {
      console.warn('[SkillGateway] initial status check failed:', err);
    });

    // Start the 8h background refresh loop (only checks git sources).
    if (!this.scheduler) {
      this.scheduler = new SkillScheduler({
        onTick: async () => {
          await this.checkForUpdates();
        },
      });
      this.scheduler.start();
    }
  }

  async dispose(): Promise<void> {
    this.scheduler?.stop();
    this.scheduler = null;
    this.skillsListeners.clear();
    this.updateListeners.clear();
  }

  /**
   * Ensure the two built-in native sources exist in the lock. Idempotent.
   * Native sources surface what's already at the provider dirs without
   * requiring user configuration.
   */
  private async ensureNativeSources(): Promise<void> {
    const lock = await readLock();
    let mutated = false;
    const seed = (id: string, name: string, target: SkillTarget) => {
      if (lock.sources.find((s) => s.id === id)) return;
      const now = new Date().toISOString();
      lock.sources.push({
        id,
        type: 'native',
        name,
        nativeTarget: target,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
      mutated = true;
    };
    seed(CLAUDE_NATIVE_SOURCE_ID, 'Claude 本地', 'claude');
    seed(CODEX_NATIVE_SOURCE_ID, 'Codex 本地', 'codex');
    if (mutated) {
      await writeLock(lock);
      this.notify(lock.skills);
    }
  }

  // ---------- Read ops (no queue needed) ----------

  async listInstalled(): Promise<InstalledSkill[]> {
    const lock = await readLock();
    return [...lock.skills].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Scan one or all enabled sources and return AvailableSkill[].
   * Sets `installed` true when the skill is already in the lock.
   */
  async browse(sourceId?: string): Promise<AvailableSkill[]> {
    const lock = await readLock();
    const sources = sourceId
      ? lock.sources.filter((s) => s.id === sourceId)
      : lock.sources.filter((s) => s.enabled);

    const installedKeys = new Set(lock.skills.map((s) => s.id));
    const out: AvailableSkill[] = [];
    for (const source of sources) {
      try {
        const result = await scanSource(source);
        for (const s of result.skills) {
          const augmented: AvailableSkill = {
            ...s,
            installed: installedKeys.has(composeSkillId(source.id, s.name)),
          };
          // For native sources, annotate "taken over by" when a lock skill has
          // promoted this provider entry.
          if (source.type === 'native' && source.nativeTarget) {
            const providerPath = path.join(getProvider(source.nativeTarget).getSkillsDir(), s.name);
            const promoted = lock.skills.find(
              (ls) => ls.targets[source.nativeTarget!]?.path === providerPath
            );
            if (promoted) augmented.takenOverBySourceId = promoted.sourceId;
          }
          out.push(augmented);
        }
      } catch (err) {
        console.warn('[SkillGateway] browse failed for source', source.id, err);
      }
    }
    return out;
  }

  /**
   * Recompute per-target status for every installed skill.
   * Returns the refreshed list and persists status changes to the lock.
   */
  async checkAllStatuses(): Promise<InstalledSkill[]> {
    return this.writeQueue.run(async () => {
      const lock = await readLock();
      let changed = false;
      for (const skill of lock.skills) {
        for (const target of Object.keys(skill.targets) as SkillTarget[]) {
          const state = skill.targets[target];
          if (!state) continue;
          const status = await checkTargetStatus(skill, state);
          if (status !== state.status) {
            state.status = status;
            changed = true;
          }
        }
      }
      if (changed) {
        await writeLock(lock);
        this.notify(lock.skills);
      }
      return lock.skills;
    });
  }

  async checkForUpdates(): Promise<UpdateAvailableInfo[]> {
    const lock = await readLock();
    const out: UpdateAvailableInfo[] = [];
    const sourceCache = new Map<string, AvailableSkill[]>();
    for (const skill of lock.skills) {
      const source = lock.sources.find((s) => s.id === skill.sourceId);
      // local sources reflect dev edits in real-time — no "update" concept
      if (!source || source.type !== 'git') continue;

      let available = sourceCache.get(source.id);
      if (!available) {
        try {
          const result = await scanSource(source);
          available = result.skills;
          sourceCache.set(source.id, available);
        } catch (err) {
          console.warn('[SkillGateway] update-check scan failed for source', source.id, err);
          continue;
        }
      }
      const match = available.find((a) => a.name === skill.name);
      if (match && match.contentHash !== skill.contentHash) {
        out.push({
          skillId: skill.id,
          name: skill.name,
          currentHash: skill.contentHash,
          remoteHash: match.contentHash,
        });
      }
    }
    if (out.length > 0) {
      this.notifyUpdates(out);
    }
    return out;
  }

  // ---------- Write ops (queued) ----------

  async install(req: InstallSkillRequest): Promise<InstalledSkill> {
    return this.writeQueue.run(async () => {
      const lock = await readLock();
      const source = lock.sources.find((s) => s.id === req.sourceId);
      if (!source) throw makeError('ENOENT_SOURCE', `Source ${req.sourceId} not found`);

      const { skills: available } = await scanSource(source);
      const target = available.find((s) => s.name === req.name);
      if (!target) {
        throw makeError('ENOENT_AVAILABLE', `Skill ${req.name} not found in source ${source.name}`);
      }

      const id = composeSkillId(req.sourceId, req.name);
      if (lock.skills.find((s) => s.id === id)) {
        throw makeError('EEXIST_INSTALLED', `Skill ${req.name} is already installed`);
      }

      const now = new Date().toISOString();
      const skill: InstalledSkill = {
        id,
        sourceId: req.sourceId,
        name: req.name,
        description: target.description,
        version: target.version,
        contentPath: target.contentPath,
        contentHash: target.contentHash,
        targets: {},
        enabled: true,
        installedAt: now,
        updatedAt: now,
      };

      for (const [tgt, opts] of Object.entries(req.targets)) {
        if (!opts) continue;
        const state = await installToTarget(skill, tgt as SkillTarget, { mode: opts.mode });
        skill.targets[tgt as SkillTarget] = state;
      }

      lock.skills.push(skill);
      await writeLock(lock);
      this.notify(lock.skills);
      return skill;
    });
  }

  /**
   * Uninstall a skill.
   * - Always removes mirror entries from every recorded target.
   * - Never touches skill.contentPath (it lives inside source-owned cache
   *   for 'git' sources, or inside the user's dev dir for 'local' sources).
   * - The lock entry is removed regardless of source type.
   */
  async uninstall(skillId: string, _options: UninstallSkillOptions = {}): Promise<void> {
    return this.writeQueue.run(async () => {
      const lock = await readLock();
      const idx = lock.skills.findIndex((s) => s.id === skillId);
      if (idx === -1) return;
      const skill = lock.skills[idx];
      if (!skill) return;

      for (const target of Object.keys(skill.targets) as SkillTarget[]) {
        await uninstallFromTarget(target, skill.name);
      }

      lock.skills.splice(idx, 1);
      await writeLock(lock);
      this.notify(lock.skills);
    });
  }

  /**
   * Re-scan source for the skill, refresh contentHash, and reinstall every
   * currently-targeted mirror. Used by the UI "sync" button on git skills.
   * For local skills it just re-hashes (no fetch).
   */
  async sync(skillId: string): Promise<InstalledSkill> {
    return this.writeQueue.run(async () => {
      const lock = await readLock();
      const skill = lock.skills.find((s) => s.id === skillId);
      if (!skill) throw makeError('ENOENT_SKILL', `Skill ${skillId} not found`);

      const source = lock.sources.find((s) => s.id === skill.sourceId);
      if (!source) throw makeError('ENOENT_SOURCE', `Source ${skill.sourceId} not found`);

      const { skills: available } = await scanSource(source);
      const match = available.find((a) => a.name === skill.name);
      if (!match) {
        throw makeError(
          'ENOENT_AVAILABLE',
          `Skill ${skill.name} no longer present in source ${source.name}`
        );
      }

      skill.contentPath = match.contentPath;
      skill.contentHash = match.contentHash;
      skill.description = match.description;
      skill.version = match.version;
      skill.updatedAt = new Date().toISOString();

      if (skill.enabled) {
        for (const target of Object.keys(skill.targets) as SkillTarget[]) {
          const state = skill.targets[target];
          if (!state) continue;
          const next = await installToTarget(skill, target, { mode: state.mode });
          skill.targets[target] = next;
        }
      }

      await writeLock(lock);
      this.notify(lock.skills);
      return skill;
    });
  }

  async setEnabled(skillId: string, enabled: boolean): Promise<void> {
    return this.writeQueue.run(async () => {
      const lock = await readLock();
      const skill = lock.skills.find((s) => s.id === skillId);
      if (!skill) throw makeError('ENOENT_SKILL', `Skill ${skillId} not found`);
      if (skill.enabled === enabled) return;

      if (enabled) {
        for (const target of Object.keys(skill.targets) as SkillTarget[]) {
          const state = skill.targets[target];
          if (!state) continue;
          const next = await installToTarget(skill, target, { mode: state.mode });
          skill.targets[target] = next;
        }
      } else {
        for (const target of Object.keys(skill.targets) as SkillTarget[]) {
          await uninstallFromTarget(target, skill.name);
          const state = skill.targets[target];
          if (state) state.status = 'missing';
        }
      }

      skill.enabled = enabled;
      skill.updatedAt = new Date().toISOString();
      await writeLock(lock);
      this.notify(lock.skills);
    });
  }

  async setTargets(
    skillId: string,
    targets: Partial<Record<SkillTarget, { mode: SkillInstallMode }>>
  ): Promise<void> {
    return this.writeQueue.run(async () => {
      const lock = await readLock();
      const skill = lock.skills.find((s) => s.id === skillId);
      if (!skill) throw makeError('ENOENT_SKILL', `Skill ${skillId} not found`);

      const before = new Set(Object.keys(skill.targets) as SkillTarget[]);
      const after = new Set(Object.keys(targets) as SkillTarget[]);

      // Drop removed targets
      for (const tgt of before) {
        if (!after.has(tgt)) {
          await uninstallFromTarget(tgt, skill.name);
          delete skill.targets[tgt];
        }
      }

      // Install / update remaining
      for (const tgt of after) {
        const opts = targets[tgt];
        if (!opts) continue;
        if (skill.enabled) {
          const state = await installToTarget(skill, tgt, { mode: opts.mode });
          skill.targets[tgt] = state;
        } else {
          skill.targets[tgt] = {
            mode: opts.mode,
            path: getTargetPath(tgt, skill.name),
            status: 'missing',
            installedAt: new Date().toISOString(),
          };
        }
      }

      skill.updatedAt = new Date().toISOString();
      await writeLock(lock);
      this.notify(lock.skills);
    });
  }

  async openFolder(skillId: string): Promise<void> {
    const lock = await readLock();
    const skill = lock.skills.find((s) => s.id === skillId);
    if (!skill) throw makeError('ENOENT_SKILL', `Skill ${skillId} not found`);
    await shell.openPath(skill.contentPath);
  }

  // ---------- Native discovery / mirror / promote / delete ----------

  async listDiscovered(): Promise<DiscoveredSkill[]> {
    return listAllDiscovered();
  }

  /**
   * Create a mirror of a native skill at another provider's dir. Pure FS op —
   * does NOT add to lock (the mirror itself becomes a new "discovered" entry
   * at the other provider on next scan, which is accurate).
   */
  async mirrorDiscovered(req: MirrorDiscoveredRequest): Promise<void> {
    return this.writeQueue.run(async () => {
      if (req.origin === req.toTarget) {
        throw makeError('EINVAL', 'origin and toTarget must differ');
      }
      const item = await findDiscovered(req.origin, req.name);
      if (!item) {
        throw makeError(
          'ENOENT_DISCOVERED',
          `Native skill ${req.name} not found under ${req.origin}`
        );
      }
      const dst = path.join(getProvider(req.toTarget).getSkillsDir(), req.name);
      await fs.promises.mkdir(path.dirname(dst), { recursive: true });
      try {
        await fs.promises.lstat(dst);
        throw makeError('EEXIST_TARGET', `${dst} already exists; remove it first`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (req.mode === 'symlink') {
        await linkOrCopy(item.contentPath, dst);
      } else {
        await copyDir(item.contentPath, dst);
      }
      // No lock mutation, but refresh listeners so the discovery overlay updates.
      this.notify((await readLock()).skills);
    });
  }

  /**
   * Adopt a native discovered skill into gateway management.
   *
   * - symlink-external: zero file movement. canonical = the dev dir (the
   *   symlink's existing target). The provider symlink already points there
   *   so we don't touch the FS.
   * - real-dir: move the provider directory into ~/.ensoai/canonical/<newId>/
   *   and replace the provider path with a symlink → canonical. User's
   *   content is preserved (now in canonical) and ~/.claude/skills/<name>
   *   becomes a gateway-managed symlink.
   *
   * Both flavors create a new type='local' SkillSource that owns the skill.
   * The original native source loses this entry on the next browse scan.
   */
  async promoteDiscovered(req: PromoteDiscoveredRequest): Promise<InstalledSkill> {
    return this.writeQueue.run(async () => {
      const item = await findDiscovered(req.origin, req.name);
      if (!item) {
        throw makeError(
          'ENOENT_DISCOVERED',
          `Native skill ${req.name} not found under ${req.origin}`
        );
      }

      const lock = await readLock();
      if (lock.skills.find((s) => s.name === req.name && req.origin in s.targets)) {
        throw makeError(
          'EEXIST_INSTALLED',
          `Skill ${req.name} is already managed for ${req.origin}`
        );
      }

      const provider = getProvider(req.origin);
      const providerPath = path.join(provider.getSkillsDir(), req.name);
      const now = new Date().toISOString();
      const sourceId = generateSourceId();

      let canonicalPath: string;

      if (item.kind === 'symlink-external') {
        if (!item.symlinkTarget) {
          throw makeError(
            'EINVAL',
            `discovered ${req.name}: symlink-external missing symlinkTarget`
          );
        }
        canonicalPath = item.symlinkTarget;
        // Refuse if another source already owns this dev dir
        if (lock.sources.find((s) => s.type === 'local' && s.localPath === canonicalPath)) {
          throw makeError('EEXIST_SOURCE', `A local source for ${canonicalPath} already exists`);
        }
        // No FS work — provider path symlink already points at canonical (dev dir)
      } else {
        // real-dir: move content into ~/.ensoai/canonical/<sourceId>/<name>/
        await ensureLayout();
        const canonicalSourceDir = path.join(getCanonicalContentRoot(), sourceId);
        await fs.promises.mkdir(canonicalSourceDir, { recursive: true });
        canonicalPath = path.join(canonicalSourceDir, req.name);

        try {
          await fs.promises.rename(providerPath, canonicalPath);
        } catch (err) {
          // Cross-device fallback (rare on macOS but possible with external drives).
          if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
            await fs.promises.cp(providerPath, canonicalPath, { recursive: true });
            await fs.promises.rm(providerPath, { recursive: true, force: true });
          } else {
            throw err;
          }
        }

        // Recreate provider path as a symlink pointing at canonical
        await fs.promises.symlink(canonicalPath, providerPath, 'dir');
      }

      const source: SkillSource = {
        id: sourceId,
        type: 'local',
        name: req.name,
        localPath: canonicalPath,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };
      lock.sources.push(source);

      const skill: InstalledSkill = {
        id: `${sourceId}::${req.name}`,
        sourceId,
        name: req.name,
        description: item.description,
        contentPath: canonicalPath,
        contentHash: item.contentHash,
        targets: {
          [req.origin]: {
            mode: 'symlink',
            path: providerPath,
            status: 'managed',
            installedAt: now,
          },
        },
        enabled: true,
        installedAt: now,
        updatedAt: now,
      };
      lock.skills.push(skill);

      await writeLock(lock);
      this.notify(lock.skills);
      return skill;
    });
  }

  /**
   * Reverse a promote operation. Two modes:
   *
   * - 'restore-to-native':
   *     symlink-external → no FS change; just drop lock + source.
   *     real-dir → move canonical content back to the provider path, replace
   *     the gateway symlink with the restored real dir, then drop canonical +
   *     lock + source.
   *
   * - 'delete-both':
   *     trash the provider entry (symlink or restored dir),
   *     trash the canonical dir if it lives under ~/.ensoai/canonical (i.e.,
   *     this was a real-dir promote — symlink-external dev dirs are NEVER
   *     touched here), drop lock + source.
   */
  async unpromote(req: UnpromoteRequest): Promise<void> {
    return this.writeQueue.run(async () => {
      const lock = await readLock();
      const skillIdx = lock.skills.findIndex((s) => s.id === req.skillId);
      if (skillIdx === -1) throw makeError('ENOENT_SKILL', `Skill ${req.skillId} not found`);
      const skill = lock.skills[skillIdx];
      const source = lock.sources.find((s) => s.id === skill.sourceId);

      const targets = Object.keys(skill.targets) as SkillTarget[];
      if (targets.length === 0) throw makeError('EINVAL', `skill ${req.skillId} has no targets`);
      // Promoted skills always have exactly one target (the origin native).
      const target = targets[0];
      const providerPath = skill.targets[target]?.path;
      if (!providerPath) throw makeError('EINVAL', `target ${target} missing path`);

      const canonicalRoot = path.resolve(getCanonicalContentRoot());
      const isRealDirPromoted = path
        .resolve(skill.contentPath)
        .startsWith(canonicalRoot + path.sep);

      if (req.mode === 'restore-to-native') {
        if (isRealDirPromoted) {
          // Move canonical back to provider path, then clean canonical dir.
          await unlinkSafe(providerPath);
          try {
            await fs.promises.rename(skill.contentPath, providerPath);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
              await fs.promises.cp(skill.contentPath, providerPath, { recursive: true });
              await fs.promises.rm(skill.contentPath, { recursive: true, force: true });
            } else {
              throw err;
            }
          }
          // Drop the now-empty <canonical>/<sourceId>/ wrapper dir.
          const canonicalSourceDir = path.dirname(skill.contentPath);
          await fs.promises
            .rm(canonicalSourceDir, { recursive: true, force: true })
            .catch(() => {});
        }
        // symlink-external: provider path is already a symlink to dev dir.
        // No FS work needed — leaving lock removal as the only effect.
      } else if (req.mode === 'delete-both') {
        const useTrash = req.moveToTrash !== false;
        try {
          if (useTrash) {
            await shell.trashItem(providerPath);
          } else {
            await fs.promises.rm(providerPath, { recursive: true, force: true });
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        if (isRealDirPromoted) {
          const canonicalSourceDir = path.dirname(skill.contentPath);
          try {
            if (useTrash) {
              await shell.trashItem(canonicalSourceDir);
            } else {
              await fs.promises.rm(canonicalSourceDir, { recursive: true, force: true });
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
        }
        // For symlink-external: dev dir (skill.contentPath) is NEVER touched.
      } else {
        throw makeError('EINVAL', `unknown unpromote mode: ${(req as { mode: string }).mode}`);
      }

      // Remove lock + the auto-created local source
      lock.skills.splice(skillIdx, 1);
      if (source && source.type === 'local') {
        const sourceIdx = lock.sources.findIndex((s) => s.id === source.id);
        if (sourceIdx !== -1) lock.sources.splice(sourceIdx, 1);
      }

      await writeLock(lock);
      this.notify(lock.skills);
    });
  }

  /**
   * Destructive removal of a native entry at a provider path.
   * Defaults to system Trash so the user can restore via Finder.
   * Cascade-removes gateway mirrors pointing at the deleted path.
   */
  async deleteNative(
    target: SkillTarget,
    name: string,
    options: DeleteNativeOptions
  ): Promise<void> {
    return this.writeQueue.run(async () => {
      const fullPath = path.join(getProvider(target).getSkillsDir(), name);

      if (options.alsoRemoveMirrors !== false) {
        const lock = await readLock();
        const others = (['claude', 'codex'] as SkillTarget[]).filter((t) => t !== target);
        let mutated = false;
        for (const otherTarget of others) {
          const otherDst = path.join(getProvider(otherTarget).getSkillsDir(), name);
          const resolved = await readlinkAbsolute(otherDst);
          if (resolved && path.resolve(resolved) === path.resolve(fullPath)) {
            await unlinkSafe(otherDst);
          }
        }
        for (const skill of lock.skills) {
          const state = skill.targets[target];
          if (state && path.resolve(state.path) === path.resolve(fullPath)) {
            delete skill.targets[target];
            skill.updatedAt = new Date().toISOString();
            mutated = true;
          }
        }
        if (mutated) await writeLock(lock);
      }

      // Idempotent against missing file; surface every other failure to the caller
      // so the user keeps their safety net (e.g. Trash permission denied stays visible).
      try {
        if (options.moveToTrash !== false) {
          await shell.trashItem(fullPath);
        } else {
          await fs.promises.rm(fullPath, { recursive: true, force: true });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      this.notify((await readLock()).skills);
    });
  }

  /**
   * Cascade-remove a source plus every skill that references it.
   * Cleans canonical content (for promoted local sources whose localPath sits
   * under ~/.ensoai/canonical/) and the git clone cache (for git sources).
   * Native sources are immutable — refuses.
   */
  async removeSourceCascade(sourceId: string): Promise<void> {
    return this.writeQueue.run(async () => {
      const lock = await readLock();
      const source = lock.sources.find((s) => s.id === sourceId);
      if (!source) return;
      if (source.type === 'native') {
        throw makeError('EREFUSED_NATIVE', 'Native sources cannot be removed');
      }

      // Drop mirrors for every dependent skill (must run before lock mutation
      // so SkillInstaller can still resolve target paths from skill state).
      const dependents = lock.skills.filter((s) => s.sourceId === sourceId);
      for (const skill of dependents) {
        for (const target of Object.keys(skill.targets) as SkillTarget[]) {
          await uninstallFromTarget(target, skill.name);
        }
      }
      lock.skills = lock.skills.filter((s) => s.sourceId !== sourceId);

      // Clean source-owned on-disk content.
      if (source.type === 'local' && source.localPath) {
        const canonicalRoot = path.resolve(getCanonicalContentRoot());
        const localPath = path.resolve(source.localPath);
        if (localPath === canonicalRoot || localPath.startsWith(canonicalRoot + path.sep)) {
          // Promoted real-dir layout: ~/.ensoai/canonical/<sourceId>/<name>
          // Remove the parent dir so the per-source bucket goes away cleanly.
          const canonicalSourceDir = path.dirname(localPath);
          await fs.promises
            .rm(canonicalSourceDir, { recursive: true, force: true })
            .catch(() => {});
        }
        // External (dev-dir) localPath stays — user owns it.
      }
      if (source.type === 'git') {
        const cloneDir = path.join(getSourcesCacheRoot(), sourceId);
        await fs.promises.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
      }

      lock.sources = lock.sources.filter((s) => s.id !== sourceId);
      await writeLock(lock);
      this.notify(lock.skills);
    });
  }

  // ---------- internals ----------

  private notify(skills: InstalledSkill[]): void {
    if (this.skillsListeners.size === 0) return;
    const snapshot = [...skills];
    for (const listener of this.skillsListeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.warn('[SkillGateway] listener threw:', err);
      }
    }
  }

  private notifyUpdates(updates: UpdateAvailableInfo[]): void {
    if (this.updateListeners.size === 0) return;
    const snapshot = [...updates];
    for (const listener of this.updateListeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.warn('[SkillGateway] updates-listener threw:', err);
      }
    }
  }
}

let instance: SkillGatewayManager | null = null;

export function getSkillGatewayManager(): SkillGatewayManager {
  if (!instance) instance = new SkillGatewayManager();
  return instance;
}

export function _resetGatewayManagerForTests(): void {
  instance = null;
}
