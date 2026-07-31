import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Clock, Loader2, X } from 'lucide-react';
import type {
  PetNotification,
  PetNotificationKind,
} from '@/pets/usePetNotifications';

function StatusIcon({ kind }: { kind: PetNotificationKind }) {
  const base = 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white';
  if (kind === 'running')
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-400" />;
  if (kind === 'success')
    return <span className={`${base} bg-emerald-500`}><Check className="h-3.5 w-3.5" /></span>;
  if (kind === 'error')
    return <span className={`${base} bg-rose-500`}><AlertTriangle className="h-3 w-3" /></span>;
  if (kind === 'pending')
    return <span className={`${base} bg-amber-400`}><Clock className="h-3 w-3" /></span>;
  return <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-400" />;
}

interface Props {
  items: PetNotification[];
  dismiss: (sessionId: string) => void;
}

/**
 * The list of notification cards (newest first). Caps its height and scrolls
 * when there are many; collapse state + the toggle live in the parent so the
 * toggle stays pinned regardless of the list.
 */
export function PetNotifications({ items, dismiss }: Props) {
  const { t } = useTranslation();

  const focus = (sessionId: string) => {
    if (sessionId) void window.electronAPI?.petFocusSession?.(sessionId);
  };

  return (
    // padding + matching negative margin gives card shadows room without
    // clipping inside the scroll viewport.
    <div
      data-pet-interactive
      className="pointer-events-auto -mx-2 -my-1.5 flex max-h-[300px] w-[300px] flex-col gap-1.5 overflow-y-auto px-2 py-1.5"
    >
      {items.map((n, i) => (
        <div
          key={n.sessionId}
          onClick={() => focus(n.sessionId)}
          className="group relative flex shrink-0 cursor-pointer items-center gap-2.5 rounded-2xl bg-white px-3.5 py-2 shadow-strong ring-1 ring-black/5 transition-colors hover:bg-neutral-50"
        >
          <div className="min-w-0 flex-1">
            {i === 0 && (
              <span className="mb-0.5 inline-block rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium leading-none text-neutral-500">
                {t('pet.notify.latest')}
              </span>
            )}
            <div className="truncate text-[13px] font-medium leading-snug text-neutral-800">
              {t(n.titleKey)}
            </div>
          </div>
          <StatusIcon kind={n.kind} />
          <button
            type="button"
            aria-label="dismiss"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(n.sessionId);
            }}
            className="absolute right-1.5 top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-neutral-700/80 text-white group-hover:flex"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
