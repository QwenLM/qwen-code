import { useId, useState } from 'react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog';
import {
  MANAGED_SURFACE_CATEGORY_LABELS,
  MANAGED_SURFACE_DECISIONS,
  type ManagedSurfaceCategory,
} from './managed-surface-decisions';

const CATEGORIES: readonly ManagedSurfaceCategory[] = [
  'configuration',
  'knowledge',
  'conversation',
  'files',
  'runtime',
];

const TEXT = {
  title: ['Managed capabilities', 'Managed 功能说明'],
  description: [
    'Daemon surfaces that differ in Managed, with their current owner. Tracked makes a gap visible; it does not mean permanent exclusion.',
    '此处列出 Managed 与 daemon 的界面差异及当前归属。「已跟踪」表示缺口可见，不表示永久排除。',
  ],
  search: ['Search surfaces', '搜索界面'],
  empty: ['No surfaces match this search.', '没有符合搜索条件的界面。'],
  tracked: ['Tracked', '已跟踪'],
  trackedIn: ['Tracked in', '跟踪于'],
} as const;

export function ManagedSurfaceDecisionsDialog() {
  const { language } = useI18n();
  const id = useId();
  const [query, setQuery] = useState('');
  const text = (value: readonly [string, string]) =>
    value[language === 'zh-CN' ? 1 : 0];
  const normalized = query.trim().toLocaleLowerCase();
  const visible = MANAGED_SURFACE_DECISIONS.filter((surface) =>
    `${surface.label[0]} ${surface.label[1]} ${surface.reason[0]} ${surface.reason[1]}`
      .toLocaleLowerCase()
      .includes(normalized),
  );

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) setQuery('');
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          {text(TEXT.title)}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"
        data-managed-surface-decisions
      >
        <DialogHeader>
          <DialogTitle>{text(TEXT.title)}</DialogTitle>
          <DialogDescription>{text(TEXT.description)}</DialogDescription>
        </DialogHeader>
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={text(TEXT.search)}
          aria-label={text(TEXT.search)}
        />
        {CATEGORIES.map((category) => {
          const surfaces = visible.filter(
            (surface) => surface.category === category,
          );
          if (surfaces.length === 0) return null;
          return (
            <section
              key={category}
              aria-labelledby={`${id}-${category}`}
              className="space-y-3"
            >
              <h3 id={`${id}-${category}`} className="text-sm font-medium">
                {text(MANAGED_SURFACE_CATEGORY_LABELS[category])}
              </h3>
              <ul className="space-y-3">
                {surfaces.map((surface) => (
                  <li
                    key={surface.id}
                    data-managed-surface={surface.id}
                    className="space-y-2 rounded-lg border p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-sm font-medium">
                        {text(surface.label)}
                      </h4>
                      <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                        {text(TEXT.tracked)}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {text(surface.reason)}
                    </p>
                    <a
                      className="inline-flex text-xs underline underline-offset-3 hover:text-foreground"
                      href={`https://github.com/QwenLM/qwen-code/issues/${surface.issue}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {text(TEXT.trackedIn)} #{surface.issue}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {visible.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            {text(TEXT.empty)}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
