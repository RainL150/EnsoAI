import type { AvailableSkill } from '@shared/types';
import { Check, Cloud, Loader2, RefreshCw } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { InstallSkillDialog } from './InstallSkillDialog';

export function BrowseSkillsTab() {
  const { t } = useI18n();
  const [items, setItems] = React.useState<AvailableSkill[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [target, setTarget] = React.useState<AvailableSkill | null>(null);

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await window.electronAPI.skills.browse();
      setItems(list);
    } catch (err) {
      toastManager.add({ type: 'error', title: (err as Error).message });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    setLoading(true);
    refresh();
    const unsub = window.electronAPI.skills.onChanged?.(() => refresh());
    return unsub;
  }, [refresh]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        {t('Loading...')}
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-2">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {items.length > 0
            ? `${items.length} ${t('skill(s) from enabled sources')}`
            : t('No skills found. Enable sources under "Sources" and refresh.')}
        </p>
        <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
          {refreshing ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3 mr-1" />
          )}
          {t('Refresh')}
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground border border-dashed rounded-lg">
          <Cloud className="h-8 w-8 opacity-40" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {items.map((skill) => (
            <div
              key={`${skill.sourceId}::${skill.name}`}
              className="flex flex-col gap-2 rounded-lg border bg-card p-4"
            >
              <div className="flex items-start gap-2">
                <Cloud className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{skill.name}</div>
                  <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                    {skill.description || t('(no description)')}
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-end pt-1">
                {skill.installed ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 text-emerald-600 border border-emerald-500/30 px-2.5 py-0.5 text-xs">
                    <Check className="h-3 w-3" />
                    {t('Installed')}
                  </span>
                ) : (
                  <Button size="sm" className="h-7 text-xs" onClick={() => setTarget(skill)}>
                    {t('Install')}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <InstallSkillDialog
        skill={target}
        open={!!target}
        onOpenChange={(v) => {
          if (!v) setTarget(null);
        }}
        onInstalled={refresh}
      />
    </div>
  );
}
