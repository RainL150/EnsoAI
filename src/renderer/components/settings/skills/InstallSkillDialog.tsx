import type { AvailableSkill, SkillTarget } from '@shared/types';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

const ALL_TARGETS: SkillTarget[] = ['claude', 'codex'];
const TARGET_LABELS: Record<SkillTarget, string> = { claude: 'Claude', codex: 'Codex' };

type Mode = 'symlink' | 'copy';

interface InstallSkillDialogProps {
  skill: AvailableSkill | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled?: () => void | Promise<void>;
}

export function InstallSkillDialog({
  skill,
  open,
  onOpenChange,
  onInstalled,
}: InstallSkillDialogProps) {
  const { t } = useI18n();
  const [targets, setTargets] = React.useState<Record<SkillTarget, boolean>>({
    claude: true,
    codex: true,
  });
  const [mode, setMode] = React.useState<Mode>('symlink');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setTargets({ claude: true, codex: true });
      setMode('symlink');
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const toggleTarget = (target: SkillTarget) => {
    setTargets((prev) => ({ ...prev, [target]: !prev[target] }));
  };

  const handleSubmit = async () => {
    if (!skill) return;
    const picked = ALL_TARGETS.filter((t) => targets[t]);
    if (picked.length === 0) {
      setError(t('Pick at least one target'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI.skills.install({
        sourceId: skill.sourceId,
        name: skill.name,
        targets: Object.fromEntries(picked.map((t) => [t, { mode }])) as Partial<
          Record<SkillTarget, { mode: Mode }>
        >,
      });
      toastManager.add({ type: 'success', title: `${t('Installed: ')}${skill.name}` });
      await onInstalled?.();
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <div className="px-4 py-3 border-b">
          <DialogTitle className="text-base font-medium">{t('Install skill')}</DialogTitle>
        </div>

        {skill && (
          <div className="p-4 space-y-4">
            <div>
              <div className="text-sm font-medium">{skill.name}</div>
              {skill.description && (
                <p className="text-xs text-muted-foreground mt-1">{skill.description}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="text-sm font-medium">{t('Targets')}</div>
              <div className="flex gap-1.5">
                {ALL_TARGETS.map((target) => {
                  const active = targets[target];
                  return (
                    <button
                      key={target}
                      type="button"
                      onClick={() => toggleTarget(target)}
                      disabled={busy}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs border transition-colors',
                        active
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-transparent text-muted-foreground border-border hover:border-foreground'
                      )}
                    >
                      {active && <Check className="h-3 w-3" />}
                      {TARGET_LABELS[target]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-sm font-medium">{t('Mode')}</div>
              <div className="flex gap-1.5">
                {(['symlink', 'copy'] as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    disabled={busy}
                    className={cn(
                      'rounded-md border px-3 py-1.5 text-xs transition-colors',
                      mode === m
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-transparent text-muted-foreground hover:border-foreground'
                    )}
                  >
                    {m === 'symlink' ? t('Symlink (recommended)') : t('Copy')}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {mode === 'symlink'
                  ? t('Symlink: lightweight, edits propagate instantly.')
                  : t('Copy: standalone, decoupled from source updates.')}
              </p>
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span className="break-all">{error}</span>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 px-4 py-3 border-t">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={busy || !skill}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
            {t('Install')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
