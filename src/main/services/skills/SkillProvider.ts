// SkillProvider abstraction — one per target AI CLI (Claude, Codex, ...).
// v2 keeps providers thin: they only know their skills dir + availability.
// All install/uninstall logic lives in SkillInstaller.

import type { SkillTarget } from '@shared/types';

export interface SkillProvider {
  readonly target: SkillTarget;
  /** Absolute path to this CLI's canonical user-scope skills directory. */
  getSkillsDir(): string;
  /**
   * Absolute directories to scan for pre-existing native skills. Defaults to
   * the canonical skills dir; providers can add compatibility locations.
   */
  getDiscoveryDirs?(): string[];
  /** Whether the skills dir exists or can be created and is writable. */
  isAvailable(): Promise<boolean>;
}
