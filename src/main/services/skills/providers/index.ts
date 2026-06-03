// Provider registry — singleton map from SkillTarget → SkillProvider.

import type { SkillTarget } from '@shared/types';
import type { SkillProvider } from '../SkillProvider';
import { ClaudeSkillProvider } from './ClaudeSkillProvider';
import { CodexSkillProvider } from './CodexSkillProvider';

let registry: Map<SkillTarget, SkillProvider> | null = null;

export function getProvider(target: SkillTarget): SkillProvider {
  if (!registry) {
    registry = new Map();
    registry.set('claude', new ClaudeSkillProvider());
    registry.set('codex', new CodexSkillProvider());
  }
  const provider = registry.get(target);
  if (!provider) {
    throw new Error(`Unknown SkillTarget: ${target}`);
  }
  return provider;
}

export function getAllProviders(): SkillProvider[] {
  // Force registry init
  getProvider('claude');
  if (!registry) throw new Error('registry not initialized');
  return Array.from(registry.values());
}
