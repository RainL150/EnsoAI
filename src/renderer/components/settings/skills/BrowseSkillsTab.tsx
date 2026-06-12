import type { AvailableSkill, SkillSource } from '@shared/types';
import { Check, Cloud, Loader2, Lock, Package, RefreshCw } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { InstallSkillDialog } from './InstallSkillDialog';

const ALL_SOURCES_VALUE = '__all__';

export function BrowseSkillsTab() {
  const { t } = useI18n();
  const [items, setItems] = React.useState<AvailableSkill[]>([]);
  const [sources, setSources] = React.useState<SkillSource[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [installTarget, setInstallTarget] = React.useState<AvailableSkill | null>(null);
  const [promotingKey, setPromotingKey] = React.useState<string | null>(null);
  const [installingKey, setInstallingKey] = React.useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = React.useState<string>(ALL_SOURCES_VALUE);

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const [list, sourceList] = await Promise.all([
        window.electronAPI.skills.browse(),
        window.electronAPI.skills.sources.list(),
      ]);
      setItems(list);
      setSources(sourceList);
    } catch (err) {
      toastManager.add({ type: 'error', title: (err as Error).message });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    refresh();
    const unsubSkills = window.electronAPI.skills.onChanged?.(() => refresh());
    const unsubSources = window.electronAPI.skills.sources.onChanged?.(() => refresh());
    return () => {
      unsubSkills?.();
      unsubSources?.();
    };
  }, [refresh]);

  const sourceById = React.useMemo(() => {
    const m = new Map<string, SkillSource>();
    for (const s of sources) m.set(s.id, s);
    return m;
  }, [sources]);

  const filtered = React.useMemo(() => {
    if (selectedSourceId === ALL_SOURCES_VALUE) return items;
    return items.filter((s) => s.sourceId === selectedSourceId);
  }, [items, selectedSourceId]);

  const handlePromote = async (skill: AvailableSkill) => {
    const source = sourceById.get(skill.sourceId);
    if (!source?.nativeTarget) return;
    const key = `${skill.sourceId}::${skill.name}`;
    setPromotingKey(key);
    try {
      await window.electronAPI.skills.promoteDiscovered({
        origin: source.nativeTarget,
        name: skill.name,
      });
      toastManager.add({ type: 'success', title: `${t('已接管')}: ${skill.name}` });
      await refresh();
    } catch (err) {
      toastManager.add({ type: 'error', title: (err as Error).message });
    } finally {
      setPromotingKey(null);
    }
  };

  const handleInstallBundle = async (skill: AvailableSkill) => {
    const source = sourceById.get(skill.sourceId);
    if (!source || source.type !== 'bundle' || !source.nativeTarget) return;
    const key = `${skill.sourceId}::${skill.name}`;
    setInstallingKey(key);
    try {
      await window.electronAPI.skills.install({
        sourceId: skill.sourceId,
        name: skill.name,
        targets: { [source.nativeTarget]: { mode: 'bundle-wrapper' } },
      });
      toastManager.add({ type: 'success', title: `${t('已纳管')}: ${skill.name}` });
      await refresh();
    } catch (err) {
      toastManager.add({ type: 'error', title: (err as Error).message });
    } finally {
      setInstallingKey(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        {t('Loading...')}
      </div>
    );
  }

  // Bundle sources are auto-tracked; they live on the Installed tab as a
  // collapsible group. Don't list them in Browse — would duplicate the rows.
  const visibleSources = sources.filter((s) => s.enabled && s.type !== 'bundle');

  return (
    <div className="space-y-3 pb-2">
      <div className="flex items-center gap-2">
        <select
          value={selectedSourceId}
          onChange={(e) => setSelectedSourceId(e.target.value)}
          disabled={refreshing}
          className="text-xs rounded-md border bg-background px-2 py-1 min-w-[180px]"
        >
          <option value={ALL_SOURCES_VALUE}>{t('全部来源')}</option>
          {visibleSources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} {s.type === 'native' ? '· 本地' : s.type === 'git' ? '· git' : ''}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground flex-1">
          {filtered.length > 0
            ? `${filtered.length} ${t('个可用 skill')}`
            : t('没有可用 skill — 启用更多来源或刷新')}
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

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground border border-dashed rounded-lg">
          <Cloud className="h-8 w-8 opacity-40" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {filtered.map((skill) => {
            const source = sourceById.get(skill.sourceId);
            const isNative = source?.type === 'native';
            const isBundle = source?.type === 'bundle';
            const isTakenOver = !!skill.takenOver;
            const key = `${skill.sourceId}::${skill.name}`;
            const promoting = promotingKey === key;
            const installingBundle = installingKey === key;
            return (
              <div key={key} className="flex flex-col gap-2 rounded-lg border bg-card p-4">
                <div className="flex items-start gap-2">
                  {isBundle ? (
                    <Package className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                  ) : isNative ? (
                    <Lock className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                  ) : (
                    <Cloud className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium truncate">{skill.name}</span>
                      {isBundle && (
                        <span
                          className="inline-flex items-center rounded-full px-1.5 py-0 text-[10px] border bg-sky-500/10 text-sky-600 border-sky-500/30"
                          title={t('由第三方安装器管理')}
                        >
                          {t('Bundle')} · {source?.bundleManager ?? 'git'}
                        </span>
                      )}
                      {isNative && (
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-1.5 py-0 text-[10px] border',
                            isTakenOver
                              ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
                              : 'bg-amber-500/15 text-amber-600 border-amber-500/30'
                          )}
                        >
                          {isTakenOver ? t('已接管') : t('未接管')}
                        </span>
                      )}
                    </div>
                    <p
                      className="text-xs text-muted-foreground line-clamp-2 mt-0.5"
                      title={skill.description || undefined}
                    >
                      {skill.description || t('(no description)')}
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-1 gap-2">
                  <span className="text-[11px] text-muted-foreground truncate flex-1">
                    {source?.name ?? skill.sourceId}
                  </span>
                  {isBundle ? (
                    skill.installed ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 text-emerald-600 border border-emerald-500/30 px-2.5 py-0.5 text-xs">
                        <Check className="h-3 w-3" />
                        {t('已纳管')}
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => handleInstallBundle(skill)}
                        disabled={installingBundle}
                      >
                        {installingBundle && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                        {t('纳管')}
                      </Button>
                    )
                  ) : isNative ? (
                    isTakenOver ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 text-emerald-600 border border-emerald-500/30 px-2.5 py-0.5 text-xs">
                        <Check className="h-3 w-3" />
                        {t('已接管')}
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => handlePromote(skill)}
                        disabled={promoting}
                      >
                        {promoting && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                        {t('接管')}
                      </Button>
                    )
                  ) : skill.installed ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 text-emerald-600 border border-emerald-500/30 px-2.5 py-0.5 text-xs">
                      <Check className="h-3 w-3" />
                      {t('已装')}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setInstallTarget(skill)}
                    >
                      {t('Install')}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <InstallSkillDialog
        skill={installTarget}
        open={!!installTarget}
        onOpenChange={(v) => {
          if (!v) setInstallTarget(null);
        }}
        onInstalled={refresh}
      />
    </div>
  );
}
