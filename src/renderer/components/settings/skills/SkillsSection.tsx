import { Boxes, Cloud, Wand2 } from 'lucide-react';
import * as React from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { BrowseSkillsTab } from './BrowseSkillsTab';
import { InstalledSkillsTab } from './InstalledSkillsTab';
import { SourcesTab } from './SourcesTab';

type SubTab = 'installed' | 'browse' | 'sources';

export function SkillsSection() {
  const { t } = useI18n();
  const [tab, setTab] = React.useState<SubTab>('installed');

  const tabs: Array<{ id: SubTab; icon: React.ElementType; label: string }> = [
    { id: 'installed', icon: Wand2, label: t('Installed') },
    { id: 'browse', icon: Cloud, label: t('Browse') },
    { id: 'sources', icon: Boxes, label: t('Sources') },
  ];

  return (
    <div className="flex flex-col h-full gap-4">
      <div>
        <h2 className="text-lg font-medium flex items-center gap-2">
          <Wand2 className="h-5 w-5" />
          {t('Skills')}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t('Cross-CLI skill management (Claude + Codex)')}
        </p>
      </div>

      <div className="flex items-center gap-1 border-b">
        {tabs.map((sub) => {
          const active = tab === sub.id;
          return (
            <button
              type="button"
              key={sub.id}
              onClick={() => setTab(sub.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-sm border-b-2 -mb-px transition-colors',
                active
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              <sub.icon className="h-3.5 w-3.5" />
              {sub.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'installed' && <InstalledSkillsTab />}
        {tab === 'browse' && <BrowseSkillsTab />}
        {tab === 'sources' && <SourcesTab />}
      </div>
    </div>
  );
}
