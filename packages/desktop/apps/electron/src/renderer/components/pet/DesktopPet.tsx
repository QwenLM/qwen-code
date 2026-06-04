import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { usePetCompanion } from '@/pets/usePetCompanion';
import { usePetActivityState } from '@/pets/usePetActivityState';
import { usePetNotifications } from '@/pets/usePetNotifications';
import { PetNotifications } from './PetNotifications';
import { QwenPet } from './QwenPet';

function ignoreDragError(promise: Promise<void> | undefined): void {
  void promise?.catch(() => {});
}

/**
 * Fills the transparent, always-on-top pet window. Everything is clustered at
 * the bottom-right: notification cards stack just above a small toggle, which
 * sits just above the draggable pet. The toggle is pinned right above the pet,
 * so collapse/expand only grows/shrinks the cards above it — the toggle and pet
 * never move.
 *
 * Click-through is per-element via elementFromPoint: only the pet, the cards
 * and the toggle are interactive; everything else passes through to the desktop.
 */
export function DesktopPet() {
  const { selectedPet, petEnabled } = usePetCompanion();
  const state = usePetActivityState();
  const { items, dismiss } = usePetNotifications();
  const [collapsed, setCollapsed] = useState(false);

  const ignoringRef = useRef(true);
  const draggingRef = useRef(false);

  const setIgnore = useCallback((ignore: boolean) => {
    if (ignore === ignoringRef.current) return;
    ignoringRef.current = ignore;
    ignoreDragError(window.electronAPI?.petWindowSetIgnoreMouse?.(ignore));
  }, []);

  useEffect(() => {
    setIgnore(true);
    const onMove = (event: MouseEvent) => {
      if (draggingRef.current) return;
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const interactive = !!el?.closest?.('[data-pet-interactive]');
      setIgnore(!interactive);
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      ignoreDragError(window.electronAPI?.petWindowSetIgnoreMouse?.(false));
    };
  }, [setIgnore]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      draggingRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      ignoreDragError(
        window.electronAPI?.beginWindowDrag?.(event.screenX, event.screenY),
      );
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if ((event.buttons & 1) === 0) return;
      ignoreDragError(
        window.electronAPI?.moveWindowDrag?.(event.screenX, event.screenY),
      );
    },
    [],
  );

  const onPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      draggingRef.current = false;
      ignoreDragError(window.electronAPI?.endWindowDrag?.());
    },
    [],
  );

  if (!petEnabled) return null;

  return (
    <div className="pointer-events-none fixed inset-0 flex flex-col items-end justify-end gap-1.5 p-2.5">
      {items.length > 0 && !collapsed && (
        <PetNotifications items={items} dismiss={dismiss} />
      )}

      {items.length > 0 && (
        <button
          type="button"
          data-pet-interactive
          aria-label="toggle notifications"
          onClick={() => setCollapsed((v) => !v)}
          className="pointer-events-auto flex h-6 items-center gap-1 rounded-full border border-neutral-200 bg-white px-1.5 text-neutral-500 shadow-xs hover:bg-neutral-50"
        >
          {collapsed && (
            <span className="pl-0.5 text-[11px] font-medium leading-none">
              {items.length}
            </span>
          )}
          {collapsed ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
      )}

      <div
        data-pet-interactive
        className="pointer-events-auto cursor-grab active:cursor-grabbing"
        title={selectedPet.displayName}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <QwenPet
          spritesheetUrl={selectedPet.spritesheetUrl}
          state={state}
          size={96}
          className="drop-shadow-[0_3px_6px_rgba(0,0,0,0.35)]"
        />
      </div>
    </div>
  );
}
