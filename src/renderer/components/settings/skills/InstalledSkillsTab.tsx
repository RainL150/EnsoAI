import type {
  DiscoveredSkill,
  InstalledSkill,
  SkillSource,
  SkillTarget,
  SkillTargetStatus,
} from '@shared/types';
import { CLAUDE_NATIVE_SOURCE_ID, CODEX_NATIVE_SOURCE_ID } from '@shared/types';
import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  History,
  Loader2,
  Package,
  RefreshCw,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { DeleteNativeDialog } from './DeleteNativeDialog';
import { NativeSkillCard } from './NativeSkillCard';
import { UnpromoteDialog } from './UnpromoteDialog';

type FilterTarget = 'all' | SkillTarget;

const ALL_TARGETS: SkillTarget[] = ['claude', 'codex'];
const TARGET_LABELS: Record<SkillTarget, string> = { claude: 'Claude', codex: 'Codex' };

const STATUS_COLORS: Record<SkillTargetStatus, string> = {
  managed: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  'bundle-managed': 'bg-sky-500/15 text-sky-600 border-sky-500/30',
  modified: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  missing: 'bg-muted text-muted-foreground border-border',
  'wrong-symlink': 'bg-rose-500/15 text-rose-600 border-rose-500/30',
};

export function InstalledSkillsTab() {
  const { t } = useI18n();
  const [skills, setSkills] = React.useState<InstalledSkill[]>([]);
  const [sources, setSources] = React.useState<SkillSource[]>([]);
  const [discovered, setDiscovered] = React.useState<DiscoveredSkill[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [syncingId, setSyncingId] = React.useState<string | null>(null);
  const [syncingBundleId, setSyncingBundleId] = React.useState<string | null>(null);
  const [uninstallingId, setUninstallingId] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<DiscoveredSkill | null>(null);
  const [unpromoteTarget, setUnpromoteTarget] = React.useState<InstalledSkill | null>(null);
  const [filter, setFilter] = React.useState<FilterTarget>('all');
  const [expandedBundles, setExpandedBundles] = React.useState<Set<string>>(new Set());

  const reload = React.useCallback(async () => {
    try {
      const [managed, sourceList, native] = await Promise.all([
        window.electronAPI.skills.list(),
        window.electronAPI.skills.sources.list(),
        window.electronAPI.skills.listDiscovered(),
      ]);
      setSkills(managed);
      setSources(sourceList);
      setDiscovered(native);
    } catch (err) {
      console.error('[InstalledSkillsTab] load failed:', err);
      toastManager.add({ type: 'error', title: t('Failed to load skills') });
    } finally {
      setLoading(false);
    }
  }, [t]);

  // A "promoted" skill is one owned by a built-in native source — promote
  // attaches the InstalledSkill directly to claude-native / codex-native so
  // SourcesTab doesn't get polluted.
  const isPromoted = React.useCallback(
    (skill: InstalledSkill): boolean =>
      skill.sourceId === CLAUDE_NATIVE_SOURCE_ID || skill.sourceId === CODEX_NATIVE_SOURCE_ID,
    []
  );

  // Skill whose targets are all bundle-wrapper — wrapper on disk is owned by
  // the bundle's installer (e.g. gstack); uninstalling here only drops the
  // EnsoAI lock row.
  const isBundleManaged = React.useCallback(
    (skill: InstalledSkill): boolean =>
      Object.values(skill.targets).some((s) => s?.mode === 'bundle-wrapper'),
    []
  );

  React.useEffect(() => {
    reload();
    const unsubscribe = window.electronAPI.skills.onChanged?.((next) => {
      setSkills(next);
      // Lock-managed change can also affect what's "discovered" (e.g., promote
      // removes a discovered entry). Re-scan native side too.
      window.electronAPI.skills
        .listDiscovered()
        .then(setDiscovered)
        .catch(() => {});
    });
    const unsubUpdates = window.electronAPI.skills.onUpdatesAvailable?.((updates) => {
      if (updates.length === 0) return;
      const names = updates
        .map((u) => u.name)
        .slice(0, 3)
        .join(', ');
      toastManager.add({
        type: 'info',
        title: `${updates.length} ${t('skill update(s) available')}`,
        description: names + (updates.length > 3 ? ` +${updates.length - 3}` : ''),
      });
    });
    return () => {
      unsubscribe?.();
      unsubUpdates?.();
    };
  }, [reload, t]);

  const handleToggleEnabled = async (id: string, enabled: boolean) => {
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s)));
    try {
      await window.electronAPI.skills.setEnabled(id, enabled);
    } catch (err) {
      toastManager.add({ type: 'error', title: (err as Error).message });
      reload();
    }
  };

  const handleToggleTarget = async (skill: InstalledSkill, target: SkillTarget) => {
    const next = Object.fromEntries(
      Object.entries(skill.targets).map(([k, v]) => [k, { mode: v?.mode ?? 'symlink' }])
    ) as Partial<Record<SkillTarget, { mode: 'symlink' | 'copy' }>>;
    const has = target in next && next[target];
    if (has) {
      delete next[target];
    } else {
      next[target] = { mode: 'symlink' };
    }
    try {
      await window.electronAPI.skills.setTargets(skill.id, next);
    } catch (err) {
      toastManager.add({ type: 'error', title: (err as Error).message });
      reload();
    }
  };

  const handleSync = async (id: string) => {
    setSyncingId(id);
    try {
      await window.electronAPI.skills.sync(id);
      toastManager.add({ type: 'success', title: t('Sync complete') });
    } catch (err) {
      toastManager.add({ type: 'error', title: (err as Error).message });
    } finally {
      setSyncingId(null);
    }
  };

  const handleUninstall = async (id: string) => {
    setUninstallingId(id);
    try {
      await window.electronAPI.skills.uninstall(id);
      toastManager.add({ type: 'success', title: t('Skill uninstalled') });
    } catch (err) {
      toastManager.add({ type: 'error', title: (err as Error).message });
    } finally {
      setUninstallingId(null);
    }
  };

  const handleSyncBundle = async (sourceId: string) => {
    setSyncingBundleId(sourceId);
    try {
      await window.electronAPI.skills.syncBundle(sourceId);
      toastManager.add({ type: 'success', title: t('Bundle 已同步') });
      await reload();
    } catch (err) {
      toastManager.add({ type: 'error', title: (err as Error).message });
    } finally {
      setSyncingBundleId(null);
    }
  };

  const toggleBundleExpanded = (sourceId: string) => {
    setExpandedBundles((prev) => {
      const next = new Set(prev);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        {t('Loading...')}
      </div>
    );
  }

  const hasAny = skills.length > 0 || discovered.length > 0;
  if (!hasAny) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground border border-dashed rounded-lg">
        <Wand2 className="h-8 w-8 opacity-40" />
        <p className="text-sm">{t('No skills installed yet')}</p>
        <p className="text-xs">{t('Add a source under "Sources" and install from "Browse".')}</p>
      </div>
    );
  }

  const visibleDiscovered =
    filter === 'all' ? [...discovered] : discovered.filter((d) => d.target === filter);
  const visibleSkills = filter === 'all' ? [...skills] : skills.filter((s) => filter in s.targets);

  // Bundle source lookup + grouping of bundle-managed sub-skills.
  const sourceById = new Map(sources.map((s) => [s.id, s] as const));
  type BundleGroup = { source: SkillSource; skills: InstalledSkill[] };
  const bundleGroups: BundleGroup[] = [];
  const bundleGroupMap = new Map<string, BundleGroup>();
  const nonBundleVisibleSkills: InstalledSkill[] = [];
  for (const skill of visibleSkills) {
    const src = sourceById.get(skill.sourceId);
    if (src?.type === 'bundle') {
      let g = bundleGroupMap.get(src.id);
      if (!g) {
        g = { source: src, skills: [] };
        bundleGroupMap.set(src.id, g);
        bundleGroups.push(g);
      }
      g.skills.push(skill);
    } else {
      nonBundleVisibleSkills.push(skill);
    }
  }
  // Stable order: bundle groups by source name; sub-skills by name.
  bundleGroups.sort((a, b) => a.source.name.localeCompare(b.source.name));
  for (const g of bundleGroups) g.skills.sort((a, b) => a.name.localeCompare(b.name));
  // Non-bundle cards: managed (已接管) first, discovered (未接管) after — each by name.
  nonBundleVisibleSkills.sort((a, b) => a.name.localeCompare(b.name));
  visibleDiscovered.sort((a, b) => a.name.localeCompare(b.name));

  const filterTabs: Array<{ id: FilterTarget; label: string; count: number }> = [
    { id: 'all', label: t('全部'), count: skills.length + discovered.length },
    {
      id: 'claude',
      label: 'Claude',
      count:
        skills.filter((s) => 'claude' in s.targets).length +
        discovered.filter((d) => d.target === 'claude').length,
    },
    {
      id: 'codex',
      label: 'Codex',
      count:
        skills.filter((s) => 'codex' in s.targets).length +
        discovered.filter((d) => d.target === 'codex').length,
    },
  ];

  return (
    <>
      <div className="flex items-center gap-1 mb-3 border-b">
        {filterTabs.map((ft) => {
          const active = filter === ft.id;
          return (
            <button
              type="button"
              key={ft.id}
              onClick={() => setFilter(ft.id)}
              className={cn(
                'px-3 py-1.5 text-xs border-b-2 -mb-px transition-colors',
                active
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {ft.label}
              <span className="ml-1 opacity-60">{ft.count}</span>
            </button>
          );
        })}
      </div>

      {bundleGroups.length > 0 && (
        <div className="flex flex-col gap-2 mb-3">
          {bundleGroups.map((group) => {
            const expanded = expandedBundles.has(group.source.id);
            const managedCount = group.skills.filter((s) =>
              Object.values(s.targets).some((t) => t?.status === 'bundle-managed')
            ).length;
            const missingCount = group.skills.length - managedCount;
            const syncing = syncingBundleId === group.source.id;
            return (
              <div
                key={`bundle::${group.source.id}`}
                className="rounded-lg border bg-card overflow-hidden"
              >
                <div className="flex items-center gap-2 px-3 py-2 hover:bg-accent/30">
                  <button
                    type="button"
                    onClick={() => toggleBundleExpanded(group.source.id)}
                    className="flex items-center gap-2 flex-1 min-w-0 text-left"
                  >
                    {expanded ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    )}
                    <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate">{group.source.name}</span>
                        <span
                          className="inline-flex items-center rounded-full px-1.5 py-0 text-[10px] border bg-sky-500/10 text-sky-600 border-sky-500/30"
                          title={t('由第三方安装器管理')}
                        >
                          {t('Bundle')} · {group.source.bundleManager ?? 'git'}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {group.skills.length} {t('个 sub-skill')}
                        {managedCount > 0 && (
                          <span className="ml-2 text-emerald-600">
                            🟢 {managedCount} {t('managed')}
                          </span>
                        )}
                        {missingCount > 0 && (
                          <span className="ml-2 text-rose-600">
                            🔴 {missingCount} {t('待修复')}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleSyncBundle(group.source.id)}
                    disabled={syncing}
                    title={t('Sync bundle')}
                  >
                    {syncing ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3 mr-1" />
                    )}
                    {t('Sync')}
                  </Button>
                </div>
                {expanded && (
                  <div className="border-t bg-background/40">
                    {group.skills.map((skill) => {
                      const target = (Object.keys(skill.targets) as SkillTarget[])[0];
                      const state = target ? skill.targets[target] : undefined;
                      const status: SkillTargetStatus = state?.status ?? 'missing';
                      return (
                        <div
                          key={skill.id}
                          className="flex items-center gap-2 px-3 py-1.5 border-b last:border-b-0 text-xs hover:bg-accent/30"
                        >
                          <Wand2 className="h-3 w-3 text-muted-foreground shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium truncate">{skill.name}</div>
                            {skill.description && (
                              <div className="text-muted-foreground truncate text-[11px]">
                                {skill.description}
                              </div>
                            )}
                          </div>
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full px-1.5 py-0 text-[10px] border shrink-0',
                              STATUS_COLORS[status]
                            )}
                            title={target ? `${TARGET_LABELS[target]} · ${status}` : status}
                          >
                            {status}
                          </span>
                          <Switch
                            checked={skill.enabled}
                            onCheckedChange={(checked) => handleToggleEnabled(skill.id, checked)}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 pb-2">
        {nonBundleVisibleSkills.map((skill) => (
          <div
            key={skill.id}
            className="flex flex-col gap-3 rounded-lg border bg-card p-4 hover:bg-accent/30 transition-colors"
          >
            <div className="flex items-start gap-2">
              <Wand2 className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{skill.name}</div>
                <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                  {skill.description || t('(no description)')}
                </p>
              </div>
              <Switch
                checked={skill.enabled}
                onCheckedChange={(checked) => handleToggleEnabled(skill.id, checked)}
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {ALL_TARGETS.map((target) => {
                const state = skill.targets[target];
                const active = !!state;
                const status: SkillTargetStatus = state?.status ?? 'missing';
                return (
                  <button
                    key={target}
                    type="button"
                    onClick={() => handleToggleTarget(skill, target)}
                    disabled={!skill.enabled}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs border transition-colors',
                      active
                        ? STATUS_COLORS[status]
                        : 'bg-transparent text-muted-foreground border-border hover:border-foreground',
                      !skill.enabled && 'opacity-40 cursor-not-allowed'
                    )}
                    title={active ? `${TARGET_LABELS[target]} · ${status}` : TARGET_LABELS[target]}
                  >
                    {active ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                    {TARGET_LABELS[target]}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1.5 pt-1 mt-auto">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => handleSync(skill.id)}
                disabled={syncingId === skill.id}
              >
                {syncingId === skill.id ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3 mr-1" />
                )}
                {t('Sync')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => window.electronAPI.skills.openFolder(skill.id)}
              >
                <FolderOpen className="h-3 w-3 mr-1" />
                {t('Open folder')}
              </Button>
              <div className="flex-1" />
              {isPromoted(skill) ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setUnpromoteTarget(skill)}
                  title={t('取消接管')}
                >
                  <History className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-destructive hover:text-destructive"
                  onClick={() => handleUninstall(skill.id)}
                  disabled={uninstallingId === skill.id}
                  title={
                    isBundleManaged(skill)
                      ? t('从 EnsoAI 移除 (wrapper 仍由 bundle 安装器维护)')
                      : t('Uninstall')
                  }
                >
                  {uninstallingId === skill.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              )}
            </div>
          </div>
        ))}
        {visibleDiscovered.map((d) => (
          <NativeSkillCard
            key={`native::${d.target}::${d.name}`}
            skill={d}
            onDelete={(s) => setDeleteTarget(s)}
            onChanged={reload}
          />
        ))}
      </div>
      <DeleteNativeDialog
        skill={deleteTarget}
        open={deleteTarget !== null}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
        onDeleted={reload}
      />
      <UnpromoteDialog
        skill={unpromoteTarget}
        open={unpromoteTarget !== null}
        onOpenChange={(v) => {
          if (!v) setUnpromoteTarget(null);
        }}
        onUnpromoted={reload}
      />
    </>
  );
}
