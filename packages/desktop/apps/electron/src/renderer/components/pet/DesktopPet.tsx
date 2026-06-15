import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Maximize2 } from 'lucide-react';
import { usePetCompanion } from '@/pets/usePetCompanion';
import { usePetActivityState } from '@/pets/usePetActivityState';
import { usePetNotifications } from '@/pets/usePetNotifications';
import { normalizePetSize } from '@/pets/pet-size';
import { PetNotifications } from './PetNotifications';
import { QwenPet } from './QwenPet';

function ignoreDragError(promise: Promise<void> | undefined): void {
  void promise?.catch(() => {});
}

type ResizeState = {
  pointerId: number;
  startScreenX: number;
  startScreenY: number;
  startSize: number;
};

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
  const { t } = useTranslation();
  const { selectedPet, petEnabled, petSize, setPetEnabled, setPetSize } =
    usePetCompanion();
  const state = usePetActivityState();
  const { items, dismiss } = usePetNotifications();
  const [collapsed, setCollapsed] = useState(false);
  const [resizePreview, setResizePreview] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const ignoringRef = useRef(true);
  const draggingRef = useRef(false);
  const resizingRef = useRef<ResizeState | null>(null);
  const resizePreviewRef = useRef<number | null>(null);

  const setIgnore = useCallback((ignore: boolean) => {
    if (ignore === ignoringRef.current) return;
    ignoringRef.current = ignore;
    ignoreDragError(window.electronAPI?.petWindowSetIgnoreMouse?.(ignore));
  }, []);

  useEffect(() => {
    setIgnore(true);
    const onMove = (event: MouseEvent) => {
      if (draggingRef.current || resizingRef.current) return;
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const interactive = !!el?.closest?.('[data-pet-interactive]');
      if (contextMenu && !interactive) setContextMenu(null);
      setIgnore(!interactive);
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      ignoreDragError(window.electronAPI?.petWindowSetIgnoreMouse?.(false));
    };
  }, [contextMenu, setIgnore]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      setContextMenu(null);
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

  const updateResizePreview = useCallback((size: number) => {
    const normalized = normalizePetSize(size);
    resizePreviewRef.current = normalized;
    setResizePreview(normalized);
  }, []);

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setContextMenu(null);
      resizingRef.current = {
        pointerId: event.pointerId,
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        startSize: resizePreviewRef.current ?? petSize,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      updateResizePreview(resizePreviewRef.current ?? petSize);
    },
    [petSize, updateResizePreview],
  );

  const onPetContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        x: Math.min(Math.max(8, event.clientX), window.innerWidth - 100),
        y: Math.min(Math.max(8, event.clientY), window.innerHeight - 44),
      });
    },
    [],
  );

  const onClosePet = useCallback(() => {
    setContextMenu(null);
    setPetEnabled(false);
    ignoreDragError(window.electronAPI?.setPetWindowEnabled?.(false));
  }, [setPetEnabled]);

  const onResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const resize = resizingRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const deltaX = event.screenX - resize.startScreenX;
      const deltaY = event.screenY - resize.startScreenY;
      const delta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
      updateResizePreview(resize.startSize + delta);
    },
    [updateResizePreview],
  );

  const onResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const resize = resizingRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const nextSize = resizePreviewRef.current ?? resize.startSize;
      resizingRef.current = null;
      resizePreviewRef.current = null;
      setResizePreview(null);
      setPetSize(nextSize);
    },
    [setPetSize],
  );

  if (!petEnabled) return null;

  const displayPetSize = resizePreview ?? petSize;

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
        className="group relative pointer-events-auto cursor-grab active:cursor-grabbing"
        title={selectedPet.displayName}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onContextMenu={onPetContextMenu}
      >
        <QwenPet
          spritesheetUrl={selectedPet.spritesheetUrl}
          state={state}
          size={displayPetSize}
          className="drop-shadow-[0_3px_6px_rgba(0,0,0,0.35)]"
        />
        <button
          type="button"
          data-pet-interactive
          aria-label="resize pet"
          title="Resize pet"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerEnd}
          onPointerCancel={onResizePointerEnd}
          className={`absolute -bottom-0.5 -right-0.5 flex h-6 w-6 cursor-nwse-resize items-center justify-center rounded-lg border border-white/15 bg-neutral-900/55 text-white shadow-[0_3px_10px_rgba(0,0,0,0.28)] backdrop-blur transition-opacity hover:bg-neutral-900/70 focus-visible:opacity-100 ${
            resizePreview == null
              ? 'opacity-0 group-hover:opacity-100'
              : 'opacity-100'
          }`}
        >
          <Maximize2 className="h-3 w-3" />
        </button>
      </div>

      {contextMenu && (
        <div
          data-pet-interactive
          className="pointer-events-auto absolute z-50 rounded-md border border-neutral-200 bg-white p-0.5 text-neutral-800 shadow-[0_5px_16px_rgba(0,0,0,0.16)]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            onClick={onClosePet}
            className="flex h-6 min-w-20 items-center rounded px-2 text-xs hover:bg-neutral-100"
          >
            {t('pet.menu.close')}
          </button>
        </div>
      )}
    </div>
  );
}
