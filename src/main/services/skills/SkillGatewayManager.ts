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
  RemoveSourceCascadeOptions,
  SkillBundleManager,
  SkillInstallMode,
  SkillSource,
  SkillTarget,
  UninstallSkillOptions,
  UnpromoteRequest,
  UpdateAvailableInfo,
} from '@shared/types';
import { CLAUDE_NATIVE_SOURCE_ID, CODEX_NATIVE_SOURCE_ID } from '@shared/types';
import { shell } from 'electron';
import { execInPty } from '../../utils/shell';
import { copyDir, linkOrCopy, readlinkAbsolute, unlinkSafe } from './linker';
import { getAllProviders, getProvider } from './providers';
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
import { migrateV1IfNeeded, migrateV25PromotedIfNeeded } from './SkillMigration';
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

/**
 * Resolve install options for a (skill, target). For bundle sources we always
 * force mode='bundle-wrapper' and inject managedBy so installToTarget can wire
 * the wrapper-managed state correctly.
 */
function resolveInstallOptions(
  source: SkillSource | undefined,
  fallbackMode: SkillInstallMode
): { mode: SkillInstallMode; managedBy?: string } {
  if (source?.type === 'bundle') {
    return { mode: 'bundle-wrapper', managedBy: source.id };
  }
  return { mode: fallbackMode };
}

function findSource(lock: { sources: SkillSource[] }, sourceId: string): SkillSource | undefined {
  return lock.sources.find((s) => s.id === sourceId);
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
    await this.ensureBundleSources().catch((err) => {
      console.warn('[SkillGateway] bundle source detection failed:', err);
    });
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

    // M11: re-home v2.5 promoted skills from auto-created local sources back
    // onto the built-in native source, and flatten canonical/<sourceId>/<name>
    // → canonical/<target>/<name>. Idempotent — re-checks each candidate.
    try {
      const m11 = await migrateV25PromotedIfNeeded();
      if (m11.migrated) {
        console.log(
          '[SkillGateway] v2.5 promoted-source migration done:',
          `${m11.promotedFixed} skills re-homed,`,
          `${m11.warnings.length} warnings`
        );
        for (const w of m11.warnings) console.warn('[SkillGateway] m11 warning:', w);
        const lock = await readLock();
        this.notify(lock.skills);
      }
    } catch (err) {
      console.warn('[SkillGateway] m11 migration failed:', err);
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

  /**
   * Auto-detect bundle installers via the universal "shim pattern":
   *   A bundle root is any directory into which two or more sibling wrappers
   *   under the same provider dir point via their SKILL.md file-symlink.
   *
   * Examples that match:
   *   ~/.claude/skills/browse/SKILL.md  → ~/.claude/skills/gstack/browse/SKILL.md
   *   ~/.claude/skills/qa/SKILL.md      → ~/.claude/skills/gstack/qa/SKILL.md
   *     → both wrappers grandparent-resolve to ~/.claude/skills/gstack → that's a bundle root
   *
   * No vendor signature is required for detection. gstack-/git-specific knobs
   * only affect the Sync action (which CLI to invoke), not whether a bundle is
   * recognized.
   *
   * After detection, all of the bundle's sub-skills are auto-tracked into the
   * lock as `bundle-wrapper` rows; a re-run diffs against the current scan
   * (new wrappers get pushed, vanished wrappers get pruned).
   */
  private async ensureBundleSources(): Promise<void> {
    const lock = await readLock();
    const now = new Date().toISOString();

    // 1) Detect bundle roots via shim pattern, per provider.
    const detected: Array<{
      root: string;
      nativeTarget: SkillTarget;
    }> = [];
    for (const provider of getAllProviders()) {
      const roots = await detectBundleRootsByShim(provider.getSkillsDir());
      for (const root of roots) {
        detected.push({ root, nativeTarget: provider.target });
      }
    }

    // 2) Ensure a SkillSource exists for each detected root (idempotent).
    let mutated = false;
    for (const { root, nativeTarget } of detected) {
      const rootAbs = path.resolve(root);
      let source = lock.sources.find(
        (s) => s.type === 'bundle' && s.bundleRoot && path.resolve(s.bundleRoot) === rootAbs
      );
      if (!source) {
        const manager = await sniffBundleManager(root);
        const remoteUrl = await readGitRemoteUrl(root);
        source = {
          id: generateSourceId(),
          type: 'bundle',
          name: path.basename(root),
          bundleRoot: root,
          bundleManager: manager,
          nativeTarget,
          repoUrl: remoteUrl,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        };
        lock.sources.push(source);
        mutated = true;
      } else if (source.nativeTarget !== nativeTarget) {
        // Bundle moved providers (unusual). Refresh attribution so install paths work.
        source.nativeTarget = nativeTarget;
        source.updatedAt = now;
        mutated = true;
      }

      // 3) Auto-track sub-skills: scan + diff against lock.
      const { skills: available } = await scanSource(source);
      const currentNames = new Set(available.map((a) => a.name));

      for (const sub of available) {
        const wrapperPath = getTargetPath(nativeTarget, sub.name);

        // Find any existing lock entry pointing at this wrapper (under any
        // source — could be a native sentinel from old promote flow).
        const existing = lock.skills.find(
          (s) => s.name === sub.name && s.targets[nativeTarget]?.path === wrapperPath
        );

        if (existing) {
          // Re-key onto this bundle source if it isn't already.
          if (existing.sourceId !== source.id) {
            existing.sourceId = source.id;
            existing.id = composeSkillId(source.id, sub.name);
            mutated = true;
          }
          // Refresh content metadata + target state.
          existing.contentPath = sub.contentPath;
          existing.contentHash = sub.contentHash;
          if (sub.description !== undefined) existing.description = sub.description;
          if (sub.version !== undefined) existing.version = sub.version;
          const state = existing.targets[nativeTarget];
          if (state) {
            state.mode = 'bundle-wrapper';
            state.managedBy = source.id;
            state.path = wrapperPath;
            state.status = await checkTargetStatus(existing, state);
          } else {
            existing.targets[nativeTarget] = {
              mode: 'bundle-wrapper',
              path: wrapperPath,
              status: await checkTargetStatus(existing, {
                mode: 'bundle-wrapper',
                path: wrapperPath,
                status: 'missing',
                installedAt: now,
                managedBy: source.id,
              }),
              installedAt: now,
              managedBy: source.id,
            };
          }
          existing.updatedAt = now;
          mutated = true;
        } else {
          // Push fresh InstalledSkill row.
          const skill: InstalledSkill = {
            id: composeSkillId(source.id, sub.name),
            sourceId: source.id,
            name: sub.name,
            description: sub.description,
            version: sub.version,
            contentPath: sub.contentPath,
            contentHash: sub.contentHash,
            targets: {
              [nativeTarget]: {
                mode: 'bundle-wrapper',
                path: wrapperPath,
                status: 'missing',
                installedAt: now,
                managedBy: source.id,
              },
            },
            enabled: true,
            installedAt: now,
            updatedAt: now,
          };
          const state = skill.targets[nativeTarget];
          if (state) state.status = await checkTargetStatus(skill, state);
          lock.skills.push(skill);
          mutated = true;
        }
      }

      // 4) Prune sub-skills that vanished from the bundle since last scan.
      const before = lock.skills.length;
      lock.skills = lock.skills.filter((s) => {
        if (s.sourceId !== source!.id) return true;
        return currentNames.has(s.name);
      });
      if (lock.skills.length !== before) mutated = true;
    }

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
    // Bundle sources are auto-tracked; their sub-skills already appear in
    // InstalledTab. Exposing them in Browse would duplicate the rows.
    const sources = sourceId
      ? lock.sources.filter((s) => s.id === sourceId && s.type !== 'bundle')
      : lock.sources.filter((s) => s.enabled && s.type !== 'bundle');

    const installedKeys = new Set(lock.skills.map((s) => s.id));
    const out: AvailableSkill[] = [];
    for (const source of sources) {
      try {
        const result = await scanSource(source);
        for (const s of result.skills) {
          // For native sources, hide entries whose provider path is already
          // owned by another source (e.g. a git-installed skill that sits at
          // ~/.agents/skills/<name> as a symlink into ~/.ensoai/sources/...).
          // Otherwise the same skill would appear under both the git source
          // and the native one, and clicking "接管" on the native row would
          // fail because findDiscovered filters lock-tracked entries.
          if (source.type === 'native' && source.nativeTarget) {
            const providerPath =
              s.nativeProviderPath ??
              path.join(getProvider(source.nativeTarget).getSkillsDir(), s.name);
            const claimedByOther = lock.skills.some(
              (ls) =>
                ls.sourceId !== source.id && ls.targets[source.nativeTarget!]?.path === providerPath
            );
            if (claimedByOther) continue;
          }
          const installed = installedKeys.has(composeSkillId(source.id, s.name));
          const augmented: AvailableSkill = {
            ...s,
            installed,
            // For native sources, "installed under native sourceId" == "taken over".
            takenOver: source.type === 'native' ? installed : undefined,
          };
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

      const isBundle = source.type === 'bundle';
      for (const [tgt, opts] of Object.entries(req.targets)) {
        if (!opts) continue;
        const mode: SkillInstallMode = isBundle ? 'bundle-wrapper' : opts.mode;
        const state = await installToTarget(skill, tgt as SkillTarget, {
          mode,
          managedBy: isBundle ? source.id : undefined,
        });
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
   * - For bundle-wrapper targets, the on-disk wrapper is preserved (it's
   *   owned by the bundle's own installer). EnsoAI only drops the lock row.
   */
  async uninstall(skillId: string, _options: UninstallSkillOptions = {}): Promise<void> {
    return this.writeQueue.run(async () => {
      const lock = await readLock();
      const idx = lock.skills.findIndex((s) => s.id === skillId);
      if (idx === -1) return;
      const skill = lock.skills[idx];
      if (!skill) return;

      for (const target of Object.keys(skill.targets) as SkillTarget[]) {
        const state = skill.targets[target];
        await uninstallFromTarget(target, skill.name, {
          preserveFs: state?.mode === 'bundle-wrapper',
        });
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
          const opts = resolveInstallOptions(source, state.mode);
          const next = await installToTarget(skill, target, opts);
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

      const source = findSource(lock, skill.sourceId);

      if (enabled) {
        for (const target of Object.keys(skill.targets) as SkillTarget[]) {
          const state = skill.targets[target];
          if (!state) continue;
          const opts = resolveInstallOptions(source, state.mode);
          const next = await installToTarget(skill, target, opts);
          skill.targets[target] = next;
        }
      } else {
        for (const target of Object.keys(skill.targets) as SkillTarget[]) {
          const state = skill.targets[target];
          await uninstallFromTarget(target, skill.name, {
            preserveFs: state?.mode === 'bundle-wrapper',
          });
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

      const source = findSource(lock, skill.sourceId);
      const before = new Set(Object.keys(skill.targets) as SkillTarget[]);
      const after = new Set(Object.keys(targets) as SkillTarget[]);

      // Drop removed targets
      for (const tgt of before) {
        if (!after.has(tgt)) {
          const state = skill.targets[tgt];
          await uninstallFromTarget(tgt, skill.name, {
            preserveFs: state?.mode === 'bundle-wrapper',
          });
          delete skill.targets[tgt];
        }
      }

      // Install / update remaining
      for (const tgt of after) {
        const opts = targets[tgt];
        if (!opts) continue;
        const resolved = resolveInstallOptions(source, opts.mode);
        if (skill.enabled) {
          const state = await installToTarget(skill, tgt, resolved);
          skill.targets[tgt] = state;
        } else {
          skill.targets[tgt] = {
            mode: resolved.mode,
            managedBy: resolved.managedBy,
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
   * - symlink-external: zero file movement. contentPath = the dev dir (the
   *   symlink's existing target). The provider symlink already points there
   *   so we don't touch the FS.
   * - real-dir: move the provider directory into ~/.ensoai/canonical/<target>/<name>/
   *   and replace the provider path with a symlink → canonical.
   *
   * The promoted skill is owned by the built-in native source (CLAUDE/CODEX
   * sentinel), NOT a new auto-generated local source. SourcesTab stays clean.
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

      const providerPath = item.providerPath;
      const now = new Date().toISOString();
      const nativeSourceId =
        req.origin === 'claude' ? CLAUDE_NATIVE_SOURCE_ID : CODEX_NATIVE_SOURCE_ID;

      let canonicalPath: string;

      if (item.kind === 'symlink-external') {
        if (!item.symlinkTarget) {
          throw makeError(
            'EINVAL',
            `discovered ${req.name}: symlink-external missing symlinkTarget`
          );
        }
        canonicalPath = item.symlinkTarget;
        // No FS work — provider path symlink already points at the dev dir.
      } else {
        // real-dir: move content into ~/.ensoai/canonical/<target>/<name>/
        await ensureLayout();
        const targetCanonicalDir = path.join(getCanonicalContentRoot(), req.origin);
        await fs.promises.mkdir(targetCanonicalDir, { recursive: true });
        canonicalPath = path.join(targetCanonicalDir, req.name);

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

      const skill: InstalledSkill = {
        id: `${nativeSourceId}::${req.name}`,
        sourceId: nativeSourceId,
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

      if (skill.sourceId !== CLAUDE_NATIVE_SOURCE_ID && skill.sourceId !== CODEX_NATIVE_SOURCE_ID) {
        throw makeError(
          'EINVAL',
          `skill ${req.skillId} is not native-owned; use uninstall instead`
        );
      }

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
          // Best-effort: drop the per-target canonical bucket if it became empty.
          await fs.promises.rmdir(path.dirname(skill.contentPath)).catch(() => {});
        }
        // symlink-external: provider path is already a symlink to dev dir — no FS work.
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
          // Trash the canonical skill dir itself (not its parent — parent is shared per-target).
          try {
            if (useTrash) {
              await shell.trashItem(skill.contentPath);
            } else {
              await fs.promises.rm(skill.contentPath, { recursive: true, force: true });
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
          await fs.promises.rmdir(path.dirname(skill.contentPath)).catch(() => {});
        }
        // For symlink-external: dev dir (skill.contentPath) is NEVER touched.
      } else {
        throw makeError('EINVAL', `unknown unpromote mode: ${(req as { mode: string }).mode}`);
      }

      // Native source is built-in; never remove it. Just drop the skill row.
      lock.skills.splice(skillIdx, 1);

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
      const item = await findDiscovered(target, name);
      const fullPath = item?.providerPath ?? path.join(getProvider(target).getSkillsDir(), name);

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
   *
   * For bundle sources, the bundleRoot stays on disk by default (it's owned
   * by the bundle's own installer). Pass options.purgeBundleRoot=true to also
   * trash the bundleRoot.
   */
  async removeSourceCascade(
    sourceId: string,
    options: RemoveSourceCascadeOptions = {}
  ): Promise<void> {
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
          const state = skill.targets[target];
          await uninstallFromTarget(target, skill.name, {
            preserveFs: state?.mode === 'bundle-wrapper',
          });
        }
      }
      lock.skills = lock.skills.filter((s) => s.sourceId !== sourceId);

      // Clean source-owned on-disk content.
      if (source.type === 'local' && source.localPath) {
        const canonicalRoot = path.resolve(getCanonicalContentRoot());
        const localPath = path.resolve(source.localPath);
        if (localPath === canonicalRoot || localPath.startsWith(canonicalRoot + path.sep)) {
          // Defensive cleanup for any leftover v2.5-style promoted bucket. New
          // promotes never reach here (they're owned by the native source).
          await fs.promises.rm(localPath, { recursive: true, force: true }).catch(() => {});
        }
        // External (dev-dir) localPath stays — user owns it.
      }
      if (source.type === 'git') {
        const cloneDir = path.join(getSourcesCacheRoot(), sourceId);
        await fs.promises.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
      }
      if (source.type === 'bundle' && options.purgeBundleRoot && source.bundleRoot) {
        try {
          await shell.trashItem(source.bundleRoot);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn('[SkillGateway] purgeBundleRoot failed:', err);
          }
        }
      }

      lock.sources = lock.sources.filter((s) => s.id !== sourceId);
      await writeLock(lock);
      this.notify(lock.skills);
    });
  }

  /**
   * Refresh a bundle source by invoking its native installer (gstack-update-check
   * + setup for gstack; git fetch + reset for plain git bundles). After the
   * fetch, refresh status for every dependent skill — the wrapper layout the
   * bundle's installer just wrote may have changed.
   */
  async syncBundle(sourceId: string): Promise<void> {
    return this.writeQueue.run(async () => {
      const lock = await readLock();
      const source = lock.sources.find((s) => s.id === sourceId);
      if (!source) throw makeError('ENOENT_SOURCE', `Source ${sourceId} not found`);
      if (source.type !== 'bundle') {
        throw makeError('EINVAL', `Source ${sourceId} is not a bundle`);
      }
      if (!source.bundleRoot) {
        throw makeError('EINVAL', `Source ${sourceId} missing bundleRoot`);
      }
      const root = source.bundleRoot;

      if (source.bundleManager === 'gstack') {
        const updateCheck = path.join(root, 'bin', 'gstack-update-check');
        const out = await execInPty(`"${updateCheck}" --force`, { timeout: 60000 }).catch((err) => {
          throw makeError('EBUNDLE_SYNC', `gstack-update-check failed: ${(err as Error).message}`);
        });
        const stdout = typeof out === 'string' ? out : ((out as { stdout?: string })?.stdout ?? '');
        if (/UPGRADE_AVAILABLE/.test(stdout)) {
          await execInPty(`"${path.join(root, 'setup')}"`, { timeout: 300000 }).catch((err) => {
            throw makeError('EBUNDLE_SYNC', `gstack setup failed: ${(err as Error).message}`);
          });
        }
      } else if (source.bundleManager === 'git') {
        await execInPty(`git -C "${root}" pull --ff-only`, { timeout: 120000 }).catch((err) => {
          throw makeError('EBUNDLE_SYNC', `git pull failed: ${(err as Error).message}`);
        });
      } else {
        throw makeError('EUNSUPPORTED', `Bundle manager '${source.bundleManager}' not syncable`);
      }

      const now = new Date().toISOString();
      source.lastRefreshAt = now;
      source.lastSuccessAt = now;
      source.lastError = undefined;
      source.updatedAt = now;

      // Re-probe wrapper status for every dependent skill — the bundle's
      // installer just rewrote the wrappers, so 'wrong-symlink' may flip back
      // to 'bundle-managed'.
      for (const skill of lock.skills) {
        if (skill.sourceId !== sourceId) continue;
        for (const target of Object.keys(skill.targets) as SkillTarget[]) {
          const state = skill.targets[target];
          if (!state) continue;
          state.status = await checkTargetStatus(skill, state);
        }
        skill.updatedAt = now;
      }

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

// ---------- Bundle detection helpers ----------

/** ≥ this many wrappers pointing into one root makes it a bundle. */
const MIN_SHIMS_FOR_BUNDLE = 2;

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect bundle roots under a provider skills dir using the universal shim
 * pattern: a directory becomes a bundle root iff at least MIN_SHIMS_FOR_BUNDLE
 * sibling wrappers under the same provider dir each have a SKILL.md
 * file-symlink that resolves to a file inside that directory.
 *
 * Returns the absolute paths of detected bundle roots (deduplicated).
 */
async function detectBundleRootsByShim(providerDir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(providerDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const grandparentCounts = new Map<string, number>();
  const grandparentEntries = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    // We need a real-dir wrapper containing a file-symlink SKILL.md.
    // Directory-level symlinks aren't the shim pattern.
    const entryPath = path.join(providerDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(entryPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const skillMd = path.join(entryPath, 'SKILL.md');
    const skillMdAlt = path.join(entryPath, 'skill.md');
    const linkTarget = (await readlinkAbsolute(skillMd)) ?? (await readlinkAbsolute(skillMdAlt));
    if (!linkTarget) continue;

    // Grandparent of the target file = bundleRoot.
    //   <root>/<sub>/SKILL.md
    //   ──────┘ this is what we want
    const subDir = path.dirname(linkTarget);
    const root = path.dirname(subDir);
    // Defensive: ignore degenerate paths.
    if (!root || root === '/' || root === '.') continue;
    // Ignore wrappers whose link target lives under sourcesRoot / canonicalRoot —
    // those are gateway-owned, not bundle-owned.
    if (
      root.startsWith(path.resolve(getSourcesCacheRoot()) + path.sep) ||
      root.startsWith(path.resolve(getCanonicalContentRoot()) + path.sep)
    ) {
      continue;
    }

    const rootAbs = path.resolve(root);
    grandparentCounts.set(rootAbs, (grandparentCounts.get(rootAbs) ?? 0) + 1);
    const set = grandparentEntries.get(rootAbs) ?? new Set();
    set.add(entry.name);
    grandparentEntries.set(rootAbs, set);
  }

  const roots: string[] = [];
  for (const [root, count] of grandparentCounts) {
    if (count >= MIN_SHIMS_FOR_BUNDLE) roots.push(root);
  }
  return roots;
}

/** Pick a sync strategy based on what tooling exists at the bundle root. */
async function sniffBundleManager(bundleRoot: string): Promise<SkillBundleManager> {
  if (await pathExists(path.join(bundleRoot, 'bin', 'gstack-update-check'))) {
    return 'gstack';
  }
  if (await pathExists(path.join(bundleRoot, '.git'))) return 'git';
  return 'unknown';
}

async function readGitRemoteUrl(bundleRoot: string): Promise<string | undefined> {
  try {
    const cfg = await fs.promises.readFile(path.join(bundleRoot, '.git', 'config'), 'utf-8');
    const m = cfg.match(/\[remote "origin"\][^[]*url\s*=\s*(\S+)/);
    return m?.[1];
  } catch {
    return undefined;
  }
}
