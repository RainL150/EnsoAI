// Codex CLI skill provider — writes to ~/.agents/skills/<name>/.
// Per OpenAI Codex docs (developers.openai.com/codex/skills) user-scope
// skills live under $HOME/.agents/skills/, NOT $HOME/.codex/.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SkillTarget } from '@shared/types';
import type { SkillProvider } from '../SkillProvider';

export class CodexSkillProvider implements SkillProvider {
  readonly target: SkillTarget = 'codex';

  getSkillsDir(): string {
    return path.join(os.homedir(), '.agents', 'skills');
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
