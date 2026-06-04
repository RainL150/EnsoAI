import type { InstalledSkill, SkillTarget } from '@shared/types';
import { AlertCircle, CheckCircle2, History, Loader2, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

interface UnpromoteDialogProps {
  skill: InstalledSkill | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUnpromoted?: () => void | Promise<void>;
}

const TARGET_LABELS: Record<SkillTarget, string> = { claude: 'Claude', codex: 'Codex' };

type Mode = 'restore-to-native' | 'delete-both';

/**
 * Heuristic: real-dir-promoted skills live under ~/.ensoai/canonical, while
 * symlink-external-promoted skills have contentPath pointing at the user's
 * dev dir. The substring match is good enough for UI text — backend uses the
 * same check authoritatively.
 */
function isRealDirPromoted(skill: InstalledSkill): boolean {
  return skill.contentPath.includes('/.ensoai/canonical/');
}

export function UnpromoteDialog({ skill, open, onOpenChange, onUnpromoted }: UnpromoteDialogProps) {
  const { t } = useI18n();
  const [mode, setMode] = React.useState<Mode>('restore-to-native');
  const [moveToTrash, setMoveToTrash] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setMode('restore-to-native');
      setMoveToTrash(true);
      setBusy(false);
      setError(null);
    }
  }, [open]);

  if (!skill) return null;

  const realDir = isRealDirPromoted(skill);
  const origin = (Object.keys(skill.targets) as SkillTarget[])[0];
  const providerPath = origin ? skill.targets[origin]?.path : undefined;

  const handleSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI.skills.unpromote({
        skillId: skill.id,
        mode,
        moveToTrash,
      });
      toastManager.add({
        type: 'success',
        title: mode === 'restore-to-native' ? t('已还原为 native') : t('已删除'),
      });
      await onUnpromoted?.();
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ModeRow = ({
    value,
    icon: Icon,
    title,
    children,
  }: {
    value: Mode;
    icon: React.ElementType;
    title: string;
    children: React.ReactNode;
  }) => (
    <button
      type="button"
      onClick={() => setMode(value)}
      disabled={busy}
      className={cn(
        'flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors',
        mode === value ? 'border-foreground bg-accent/40' : 'border-border hover:border-foreground'
      )}
    >
      <input type="radio" readOnly checked={mode === value} className="mt-1 accent-foreground" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Icon className="h-3.5 w-3.5" />
          {title}
        </div>
        <div className="mt-1 text-xs text-muted-foreground space-y-0.5">{children}</div>
      </div>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <div className="px-4 py-3 border-b">
          <DialogTitle className="text-base font-medium">
            {t('取消接管')} "{skill.name}"
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {realDir
              ? t('类型：real-dir，canonical 位于 ~/.ensoai/canonical')
              : t('类型：symlink-external，canonical 在你的开发目录')}
          </p>
        </div>

        <div className="p-4 space-y-3">
          <ModeRow value="restore-to-native" icon={History} title={t('方式 A — 还原为 native')}>
            {realDir ? (
              <>
                <div>{t('canonical 内容 mv 回原位置，恢复为真目录')}</div>
                <div className="font-mono opacity-80 break-all">↩ {providerPath}</div>
                <div>{t('删除 canonical 目录 + lock 条目 + auto-created source')}</div>
              </>
            ) : (
              <>
                <div className="text-emerald-700 dark:text-emerald-400">
                  ✅ {t('不动任何文件，仅从 lock 移除')}
                </div>
                <div className="font-mono opacity-80 break-all">
                  ↩ {providerPath} {t('仍指向 dev 目录')}
                </div>
                <div className="opacity-80 break-all">
                  ✅ dev: {skill.contentPath} {t('保留')}
                </div>
              </>
            )}
          </ModeRow>

          <ModeRow value="delete-both" icon={Trash2} title={t('方式 B — 连同删除')}>
            {realDir ? (
              <>
                <div>{t('删除 provider 位置 symlink + canonical 内容')}</div>
                <div className="font-mono opacity-80 break-all">🗑 {providerPath}</div>
                <div className="font-mono opacity-80 break-all">🗑 {skill.contentPath}</div>
              </>
            ) : (
              <>
                <div>{t('删除 provider 位置 symlink')}</div>
                <div className="font-mono opacity-80 break-all">🗑 {providerPath}</div>
                <div className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" />
                  {t('dev 目录绝对保留')}
                  <span className="font-mono opacity-80 break-all">— {skill.contentPath}</span>
                </div>
              </>
            )}
          </ModeRow>

          {mode === 'delete-both' && (
            <label className="flex items-start gap-2 cursor-pointer py-1">
              <Checkbox
                checked={moveToTrash}
                onCheckedChange={(checked) => setMoveToTrash(checked === true)}
                disabled={busy}
                className="mt-0.5"
              />
              <div className="text-xs min-w-0">
                <div className="font-medium">{t('移到系统垃圾箱')}</div>
                <div className="text-muted-foreground">{t('可从 Finder 恢复')}</div>
              </div>
            </label>
          )}

          {origin && (
            <div className="text-[11px] text-muted-foreground opacity-80">
              {t('来源 provider')}: {TARGET_LABELS[origin]}
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
          <Button
            size="sm"
            variant={mode === 'delete-both' ? 'destructive' : 'default'}
            onClick={handleSubmit}
            disabled={busy}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
            {t('确认')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
