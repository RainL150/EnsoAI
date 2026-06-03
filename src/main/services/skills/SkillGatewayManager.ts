// Top-level orchestrator. Ties Sources / Repository / Installer / Lock together.
// All write ops go through the WriteQueue to serialize lock-file mutations.

import type {
  AvailableSkill,
  InstalledSkill,
  InstallSkillRequest,
  SkillInstallMode,
  SkillSource,
  SkillTarget,
  UninstallSkillOptions,
  UpdateAvailableInfo,
} from '@shared/types';
import { shell } from 'electron';
import {
  checkTargetStatus,
  getTargetPath,
  installToTarget,
  uninstallFromTarget,
} from './SkillInstaller';
import { readLock, writeLock } from './SkillLockStore';
import { scanSource } from './SkillRepository';
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

  subscribe(listener: SkillsListener): () => void {
    this.skillsListeners.add(listener);
    return () => this.skillsListeners.delete(listener);
  }

  subscribeUpdates(listener: UpdatesListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.skillsListeners.clear();
    this.updateListeners.clear();
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
          out.push({ ...s, installed: installedKeys.has(composeSkillId(source.id, s.name)) });
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
