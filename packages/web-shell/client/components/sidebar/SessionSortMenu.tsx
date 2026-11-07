import { ArrowDownWideNarrowIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

export type SessionSort = 'updatedAt' | 'lastUserPromptAt';

export function readSessionSort(host: string): SessionSort {
  try {
    return localStorage.getItem(`web-shell:session-sort:${host}`) ===
      'lastUserPromptAt'
      ? 'lastUserPromptAt'
      : 'updatedAt';
  } catch {
    return 'updatedAt';
  }
}

export function writeSessionSort(host: string, sort: SessionSort): void {
  try {
    localStorage.setItem(`web-shell:session-sort:${host}`, sort);
  } catch {
    // Storage may be disabled by an embedding host.
  }
}

export function SessionSortMenu({
  value,
  onChange,
}: {
  value: SessionSort;
  onChange: (value: SessionSort) => void;
}) {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="rounded-lg p-2 hover:bg-accent"
          aria-label={t('sidebar.sessionSort')}
          title={t(
            value === 'lastUserPromptAt'
              ? 'sidebar.sortQuestion'
              : 'sidebar.sortActivity',
          )}
        >
          <ArrowDownWideNarrowIcon size={18} strokeWidth={1.5} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (next === 'updatedAt' || next === 'lastUserPromptAt')
              onChange(next);
          }}
        >
          <DropdownMenuRadioItem value="updatedAt">
            {t('sidebar.sortActivity')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="lastUserPromptAt">
            {t('sidebar.sortQuestion')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
