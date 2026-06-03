// Claude Code skill provider — writes to ~/.claude/skills/<name>/.
// Respects CLAUDE_CONFIG_DIR env override.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SkillTarget } from '@shared/types';
import type { SkillProvider } from '../SkillProvider';

export class ClaudeSkillProvider implements SkillProvider {
  readonly target: SkillTarget = 'claude';

  getSkillsDir(): string {
    const override = process.env.CLAUDE_CONFIG_DIR?.trim();
    const root = override && override.length > 0 ? override : path.join(os.homedir(), '.claude');
    return path.join(root, 'skills');
  }

  async isAvailable(): Promise<boolean> {
    const dir = this.getSkillsDir();
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.access(dir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}
