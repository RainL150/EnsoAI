// SkillProvider abstraction — one per target AI CLI (Claude, Codex, ...).
// v2 keeps providers thin: they only know their skills dir + availability.
// All install/uninstall logic lives in SkillInstaller.

import type { SkillTarget } from '@shared/types';

export interface SkillProvider {
  readonly target: SkillTarget;
  /** Absolute path to this CLI's user-scope skills directory. */
  getSkillsDir(): string;
  /** Whether the skills dir exists or can be created and is writable. */
  isAvailable(): Promise<boolean>;
}
