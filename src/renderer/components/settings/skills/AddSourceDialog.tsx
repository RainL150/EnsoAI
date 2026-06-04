import type { AddSkillSourceRequest } from '@shared/types';
import { AlertCircle, Folder, GitBranch, Loader2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

interface AddSourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded?: () => void | Promise<void>;
}

type SourceType = 'git' | 'local';

const URL_REGEX = /^(https?:\/\/|git@)[\w.@:/~-]+(\.git)?$/i;

export function AddSourceDialog({ open, onOpenChange, onAdded }: AddSourceDialogProps) {
  const { t } = useI18n();
  const [type, setType] = React.useState<SourceType>('git');
  const [name, setName] = React.useState('');
  const [repoUrl, setRepoUrl] = React.useState('');
  const [branch, setBranch] = React.useState('main');
  const [sourceDir, setSourceDir] = React.useState('.');
  const [localPath, setLocalPath] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setType('git');
      setName('');
      setRepoUrl('');
      setBranch('main');
      setSourceDir('.');
      setLocalPath('');
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const validateAndSubmit = async () => {
    setError(null);
    if (!name.trim()) {
      setError(t('Name is required'));
      return;
    }
    let req: AddSkillSourceRequest;
    if (type === 'git') {
      if (!URL_REGEX.test(repoUrl.trim())) {
        setError(t('Invalid Git URL'));
        return;
      }
      req = {
        type: 'git',
        name: name.trim(),
        repoUrl: repoUrl.trim(),
        branch: branch.trim() || 'main',
        sourceDir: sourceDir.trim() || '.',
      };
    } else {
      if (!localPath.trim()) {
        setError(t('Local path is required'));
        return;
      }
      req = { type: 'local', name: name.trim(), localPath: localPath.trim() };
    }

    setBusy(true);
    try {
      await window.electronAPI.skills.sources.add(req);
      toastManager.add({ type: 'success', title: t('Source added') });
      await onAdded?.();
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pickLocalDir = async () => {
    try {
      const picked = await window.electronAPI.dialog.openDirectory();
      if (picked) setLocalPath(picked);
    } catch (err) {
      console.warn('[AddSource] dir picker failed:', err);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <div className="px-4 py-3 border-b">
          <DialogTitle className="text-base font-medium">{t('Add skill source')}</DialogTitle>
        </div>

        <div className="p-4 space-y-4">
          <div className="space-y-1.5">
            <div className="text-sm font-medium">{t('Type')}</div>
            <div className="flex gap-1.5">
              {(['git', 'local'] as SourceType[]).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setType(opt)}
                  disabled={busy}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors',
                    type === opt
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-transparent text-muted-foreground hover:border-foreground'
                  )}
                >
                  {opt === 'git' ? (
                    <GitBranch className="h-3 w-3" />
                  ) : (
                    <Folder className="h-3 w-3" />
                  )}
                  {opt === 'git' ? t('Git repository') : t('Local directory')}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="src-name" className="text-sm font-medium">
              {t('Name')}
            </label>
            <Input
              id="src-name"
              placeholder={t('My skill source')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </div>

          {type === 'git' ? (
            <>
              <div className="space-y-1.5">
                <label htmlFor="src-url" className="text-sm font-medium">
                  {t('Repository URL')}
                </label>
                <Input
                  id="src-url"
                  placeholder="https://github.com/owner/repo.git"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  disabled={busy}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <label htmlFor="src-branch" className="text-sm font-medium">
                    {t('Branch')}
                  </label>
                  <Input
                    id="src-branch"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    disabled={busy}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="src-dir" className="text-sm font-medium">
                    {t('Source dir')}
                  </label>
                  <Input
                    id="src-dir"
                    placeholder="."
                    value={sourceDir}
                    onChange={(e) => setSourceDir(e.target.value)}
                    disabled={busy}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('"." = single-skill repo; "skills" = directory containing many.')}
              </p>
            </>
          ) : (
            <div className="space-y-1.5">
              <label htmlFor="src-local" className="text-sm font-medium">
                {t('Local path')}
              </label>
              <div className="flex gap-1.5">
                <Input
                  id="src-local"
                  placeholder="/Users/you/skills/my-skill"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  disabled={busy}
                  className="flex-1"
                />
                <Button variant="outline" size="sm" onClick={pickLocalDir} disabled={busy}>
                  {t('Browse...')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('Point at a dir containing SKILL.md or a parent dir of many skills.')}
              </p>
            </div>
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
          <Button size="sm" onClick={validateAndSubmit} disabled={busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
            {t('Add')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
