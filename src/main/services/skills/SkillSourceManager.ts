// CRUD for SkillSource entries in the lock file.
// Does NOT do git fetch / repo scanning — that lives in M3's SkillRepository.

import type { AddSkillSourceRequest, SkillSource } from '@shared/types';
import { generateSourceId, readLock, writeLock } from './SkillLockStore';

type ChangeListener = (sources: SkillSource[]) => void;

export class SkillSourceManager {
  private listeners = new Set<ChangeListener>();

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(): Promise<SkillSource[]> {
    const lock = await readLock();
    return [...lock.sources].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async add(req: AddSkillSourceRequest): Promise<SkillSource> {
    this.validateAddRequest(req);
    const lock = await readLock();

    // Prevent duplicate same-content sources
    if (req.type === 'git') {
      const duplicate = lock.sources.find(
        (s) =>
          s.type === 'git' &&
          s.repoUrl === req.repoUrl &&
          (s.branch ?? 'main') === (req.branch ?? 'main') &&
          (s.sourceDir ?? '.') === (req.sourceDir ?? '.')
      );
      if (duplicate) {
        throw makeError(
          'EEXIST_SOURCE',
          `A git source for ${req.repoUrl} (${req.branch ?? 'main'} / ${req.sourceDir ?? '.'}) already exists`
        );
      }
    } else if (req.type === 'local') {
      const duplicate = lock.sources.find(
        (s) => s.type === 'local' && s.localPath === req.localPath
      );
      if (duplicate) {
        throw makeError('EEXIST_SOURCE', `A local source for ${req.localPath} already exists`);
      }
    }

    const now = new Date().toISOString();
    const source: SkillSource = {
      id: generateSourceId(),
      type: req.type,
      name: req.name,
      repoUrl: req.repoUrl,
      branch: req.branch,
      sourceDir: req.sourceDir,
      localPath: req.localPath,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    lock.sources.push(source);
    await writeLock(lock);
    this.notify(lock.sources);
    return source;
  }

  async remove(id: string): Promise<void> {
    const lock = await readLock();
    const idx = lock.sources.findIndex((s) => s.id === id);
    if (idx === -1) return;

    // Refuse if any installed skill still references this source — caller must
    // uninstall those first. Cascade-uninstall is the SkillGatewayManager's
    // concern (M5); SourceManager stays focused on lock data integrity.
    const dependents = lock.skills.filter((skill) => skill.sourceId === id);
    if (dependents.length > 0) {
      throw makeError(
        'EBUSY_SOURCE',
        `Source has ${dependents.length} installed skill(s); uninstall them first`
      );
    }

    lock.sources.splice(idx, 1);
    await writeLock(lock);
    this.notify(lock.sources);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const lock = await readLock();
    const source = lock.sources.find((s) => s.id === id);
    if (!source) throw makeError('ENOENT_SOURCE', `Source ${id} not found`);
    if (source.enabled === enabled) return;
    source.enabled = enabled;
    source.updatedAt = new Date().toISOString();
    await writeLock(lock);
    this.notify(lock.sources);
  }

  /**
   * Edit user-facing fields. Type and id are immutable.
   * Returns the updated source.
   */
  async update(
    id: string,
    patch: Partial<Pick<SkillSource, 'name' | 'branch' | 'sourceDir' | 'localPath'>>
  ): Promise<SkillSource> {
    const lock = await readLock();
    const source = lock.sources.find((s) => s.id === id);
    if (!source) throw makeError('ENOENT_SOURCE', `Source ${id} not found`);
    if (patch.name !== undefined) source.name = patch.name;
    if (patch.branch !== undefined && source.type === 'git') source.branch = patch.branch;
    if (patch.sourceDir !== undefined && source.type === 'git') source.sourceDir = patch.sourceDir;
    if (patch.localPath !== undefined && source.type === 'local')
      source.localPath = patch.localPath;
    source.updatedAt = new Date().toISOString();
    await writeLock(lock);
    this.notify(lock.sources);
    return source;
  }

  /**
   * Used by SkillRepository (M3) to record refresh outcomes back into the lock.
   * Caller owns the timestamps.
   */
  async recordRefresh(
    id: string,
    outcome: { ok: true } | { ok: false; error: string }
  ): Promise<void> {
    const lock = await readLock();
    const source = lock.sources.find((s) => s.id === id);
    if (!source) return;
    const now = new Date().toISOString();
    source.lastRefreshAt = now;
    if (outcome.ok) {
      source.lastSuccessAt = now;
      source.lastError = undefined;
    } else {
      source.lastError = outcome.error;
    }
    source.updatedAt = now;
    await writeLock(lock);
    this.notify(lock.sources);
  }

  private validateAddRequest(req: AddSkillSourceRequest): void {
    if (!req.name?.trim()) throw makeError('EINVAL', 'name is required');
    if (req.type === 'git') {
      if (!req.repoUrl?.trim()) throw makeError('EINVAL', 'repoUrl is required for git source');
      if (!/^(https?:\/\/|git@)/i.test(req.repoUrl)) {
        throw makeError('EINVAL_URL', `Invalid git URL: ${req.repoUrl}`);
      }
    } else if (req.type === 'local') {
      if (!req.localPath?.trim()) {
        throw makeError('EINVAL', 'localPath is required for local source');
      }
    } else {
      throw makeError('EINVAL', `Unknown source type: ${(req as { type: string }).type}`);
    }
  }

  private notify(sources: SkillSource[]): void {
    for (const listener of this.listeners) {
      try {
        listener(sources);
      } catch (err) {
        console.warn('[SkillSourceManager] listener threw:', err);
      }
    }
  }
}

function makeError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

let instance: SkillSourceManager | null = null;

export function getSkillSourceManager(): SkillSourceManager {
  if (!instance) instance = new SkillSourceManager();
  return instance;
}

export function _resetSourceManagerForTests(): void {
  instance = null;
}
