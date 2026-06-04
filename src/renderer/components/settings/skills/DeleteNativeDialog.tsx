import type { DiscoveredSkill, SkillTarget } from '@shared/types';
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';

interface DeleteNativeDialogProps {
  skill: DiscoveredSkill | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void | Promise<void>;
}

const TARGET_LABELS: Record<SkillTarget, string> = { claude: 'Claude', codex: 'Codex' };

export function DeleteNativeDialog({
  skill,
  open,
  onOpenChange,
  onDeleted,
}: DeleteNativeDialogProps) {
  const { t } = useI18n();
  const [moveToTrash, setMoveToTrash] = React.useState(true);
  const [alsoRemoveMirrors, setAlsoRemoveMirrors] = React.useState(true);
  const [confirmPermanent, setConfirmPermanent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setMoveToTrash(true);
      setAlsoRemoveMirrors(true);
      setConfirmPermanent(false);
      setBusy(false);
      setError(null);
    }
  }, [open]);

  if (!skill) return null;

  const handleDelete = async () => {
    if (!moveToTrash && skill.kind === 'real-dir' && !confirmPermanent) {
      setError(t('Tick "I understand this is permanent" first.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI.skills.deleteNative(skill.target, skill.name, {
        moveToTrash,
        alsoRemoveMirrors,
      });
      toastManager.add({
        type: 'success',
        title: moveToTrash ? t('Moved to Trash') : t('Permanently deleted'),
      });
      await onDeleted?.();
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const requiresExtraConfirm = !moveToTrash && skill.kind === 'real-dir';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <div className="px-4 py-3 border-b">
          <DialogTitle className="text-base font-medium flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-destructive" />
            {t('Delete')} "{skill.name}"
          </DialogTitle>
        </div>

        <div className="p-4 space-y-3">
          <div className="text-xs space-y-1">
            <div className="text-muted-foreground">{t('Path to be removed:')}</div>
            <div className="font-mono text-foreground break-all bg-muted px-2 py-1.5 rounded">
              {skill.kind === 'symlink-external'
                ? `~/.${skill.target === 'claude' ? 'claude' : 'agents'}/skills/${skill.name}`
                : skill.contentPath}
            </div>
          </div>

          {skill.kind === 'symlink-external' ? (
            <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div>{t('This is a symlink. Only the symlink is removed.')}</div>
                <div className="font-mono mt-0.5 truncate opacity-80">
                  {t('Preserved:')} {skill.symlinkTarget}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{t('This is a real folder. All contents will be removed.')}</span>
            </div>
          )}

          <label className="flex items-start gap-2 cursor-pointer py-1">
            <Checkbox
              checked={moveToTrash}
              onCheckedChange={(checked) => setMoveToTrash(checked === true)}
              disabled={busy}
              className="mt-0.5"
            />
            <div className="text-xs min-w-0">
              <div className="font-medium">{t('Move to system Trash')}</div>
              <div className="text-muted-foreground">{t('Restorable from Finder Trash.')}</div>
            </div>
          </label>

          <label className="flex items-start gap-2 cursor-pointer py-1">
            <Checkbox
              checked={alsoRemoveMirrors}
              onCheckedChange={(checked) => setAlsoRemoveMirrors(checked === true)}
              disabled={busy}
              className="mt-0.5"
            />
            <div className="text-xs min-w-0">
              <div className="font-medium">{t('Also remove mirrors pointing here')}</div>
              <div className="text-muted-foreground">
                {t(
                  'Cleans up other-provider symlinks (e.g. ~/.agents/skills/<name>) that would otherwise dangle.'
                )}
              </div>
            </div>
          </label>

          {requiresExtraConfirm && (
            <label className="flex items-start gap-2 cursor-pointer py-1 border border-destructive/30 bg-destructive/5 rounded px-2">
              <Checkbox
                checked={confirmPermanent}
                onCheckedChange={(checked) => setConfirmPermanent(checked === true)}
                disabled={busy}
                className="mt-0.5"
              />
              <div className="text-xs text-destructive">
                {t('I understand this is permanent and cannot be undone.')}
              </div>
            </label>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={handleDelete}
            disabled={busy || (requiresExtraConfirm && !confirmPermanent)}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
            {t('Delete')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
