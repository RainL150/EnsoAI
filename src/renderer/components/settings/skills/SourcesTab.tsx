import type { SkillSource } from '@shared/types';
import { Boxes, Folder, GitBranch, Loader2, Lock, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { AddSourceDialog } from './AddSourceDialog';

export function SourcesTab() {
  const { t } = useI18n();
  const [sources, setSources] = React.useState<SkillSource[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [addOpen, setAddOpen] = React.useState(false);
  const [removingId, setRemovingId] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const list = await window.electronAPI.skills.sources.list();
      setSources(list);
    } catch (err) {
      toastManager.add({ type: 'error', title: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    reload();
    const unsub = window.electronAPI.skills.sources.onChanged?.((next) => setSources(next));
    return unsub;
  }, [reload]);

  const handleToggle = async (id: string, enabled: boolean) => {
    setSources((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)));
    try {
      await window.electronAPI.skills.sources.setEnabled(id, enabled);
    } catch (err) {
      toastManager.add({ type: 'error', title: (err as Error).message });
      reload();
    }
  };

  const handleRemove = async (id: string) => {
    setRemovingId(id);
    try {
      await window.electronAPI.skills.sources.remove(id);
      toastManager.add({ type: 'success', title: t('Source removed') });
    } catch (err) {
      toastManager.add({ type: 'error', title: (err as Error).message });
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="space-y-3 pb-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {sources.length} {t('source(s)')}
        </p>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          {t('Add source')}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          {t('Loading...')}
        </div>
      ) : sources.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground border border-dashed rounded-lg">
          <Boxes className="h-8 w-8 opacity-40" />
          <p className="text-sm">{t('No sources configured')}</p>
          <p className="text-xs">{t('Add a Git repo URL or a local skill directory.')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sources.map((source) => {
            const isNative = source.type === 'native';
            return (
              <div
                key={source.id}
                className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 hover:bg-accent/30"
              >
                {isNative ? (
                  <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : source.type === 'git' ? (
                  <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate">{source.name}</span>
                    {isNative && (
                      <span className="inline-flex items-center rounded-full px-1.5 py-0 text-[10px] border bg-muted text-muted-foreground border-border">
                        {t('内置')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {isNative
                      ? source.nativeTarget === 'claude'
                        ? '~/.claude/skills'
                        : '~/.agents/skills'
                      : source.type === 'git'
                        ? `${source.repoUrl}${source.branch ? ` · ${source.branch}` : ''}${source.sourceDir && source.sourceDir !== '.' ? ` · ${source.sourceDir}` : ''}`
                        : source.localPath}
                    {source.lastError && (
                      <span className="text-destructive ml-2">⚠ {source.lastError}</span>
                    )}
                  </div>
                </div>
                <Switch
                  checked={source.enabled}
                  onCheckedChange={(checked) => handleToggle(source.id, checked)}
                />
                {isNative ? (
                  <span
                    className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground opacity-40"
                    title={t('内置 source 不可删除')}
                  >
                    <Lock className="h-3.5 w-3.5" />
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleRemove(source.id)}
                    disabled={removingId === source.id}
                    title={t('Remove')}
                  >
                    {removingId === source.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AddSourceDialog open={addOpen} onOpenChange={setAddOpen} onAdded={reload} />
    </div>
  );
}
