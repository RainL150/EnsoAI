import type { DiscoveredSkill, SkillTarget } from '@shared/types';
import { Check, FolderOpen, GitFork, Loader2, Sparkles, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

interface NativeSkillCardProps {
  skill: DiscoveredSkill;
  onDelete: (skill: DiscoveredSkill) => void;
  onChanged: () => void | Promise<void>;
}

const TARGET_LABELS: Record<SkillTarget, string> = { claude: 'Claude', codex: 'Codex' };
const ALL_TARGETS: SkillTarget[] = ['claude', 'codex'];

export function NativeSkillCard({ skill, onDelete, onChanged }: NativeSkillCardProps) {
  const { t } = useI18n();
  const [mirroringTarget, setMirroringTarget] = React.useState<SkillTarget | null>(null);
  const [promoting, setPromoting] = React.useState(false);

  const otherTarget = ALL_TARGETS.find((t) => t !== skill.target) as SkillTarget;

  const handleMirror = async () => {
    setMirroringTarget(otherTarget);
    try {
      await window.electronAPI.skills.mirrorDiscovered({
        origin: skill.target,
        name: skill.name,
        toTarget: otherTarget,
        mode: 'symlink',
      });
      toastManager.add({
        type: 'success',
        title: `${t('Mirrored to')} ${TARGET_LABELS[otherTarget]}`,
      });
      await onChanged();
    } catch (err) {
      toastManager.add({ type: 'error', title: (err as Error).message });
    } finally {
      setMirroringTarget(null);
    }
  };

  const handlePromote = async () => {
    setPromoting(true);
    try {
      await window.electronAPI.skills.promoteDiscovered({
        origin: skill.target,
        name: skill.name,
      });
      toastManager.add({ type: 'success', title: t('Promoted to gateway management') });
      await onChanged();
    } catch (err) {
      toastManager.add({ type: 'error', title: (err as Error).message });
    } finally {
      setPromoting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 hover:bg-accent/30 transition-colors">
      <div className="flex items-start gap-2">
        <Sparkles className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium truncate">{skill.name}</span>
            <span
              className={cn(
                'inline-flex items-center rounded-full px-1.5 py-0 text-[10px] border',
                'bg-sky-500/10 text-sky-600 border-sky-500/30'
              )}
              title={t('Not yet managed by EnsoAI gateway')}
            >
              {t('Native')} · {TARGET_LABELS[skill.target]}
            </span>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
            {skill.description || t('(no description)')}
          </p>
        </div>
      </div>

      <div className="text-[11px] text-muted-foreground flex items-start gap-1.5 min-w-0">
        {skill.kind === 'symlink-external' ? (
          <>
            <GitFork className="h-3 w-3 mt-0.5 shrink-0" />
            <span className="truncate">
              <span className="opacity-60">↳ </span>
              {skill.symlinkTarget}
            </span>
          </>
        ) : (
          <>
            <FolderOpen className="h-3 w-3 mt-0.5 shrink-0" />
            <span className="truncate">{skill.contentPath}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-1.5 pt-1 mt-auto flex-wrap">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={handleMirror}
          disabled={mirroringTarget !== null}
        >
          {mirroringTarget !== null ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <Check className="h-3 w-3 mr-1" />
          )}
          {t('Mirror to')} {TARGET_LABELS[otherTarget]}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={handlePromote}
          disabled={promoting}
        >
          {promoting && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
          {t('Take over')}
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-destructive hover:text-destructive"
          onClick={() => onDelete(skill)}
          title={t('Delete')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
