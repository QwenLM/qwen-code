import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

export const LONG_PRESS_DELAY_MS = 450;
export const LONG_PRESS_MOVE_THRESHOLD_PX = 10;
const SUPPRESS_CLICK_TIMEOUT_MS = 600;

const INTERACTIVE_DESCENDANT_SELECTOR =
  'button, a, input, textarea, select, [data-no-long-press]';

export interface UseLongPressOptions {
  enabled: boolean;
  onLongPress: () => void;
  delayMs?: number;
  moveThresholdPx?: number;
}

export interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}

export interface UseLongPressResult {
  pressing: boolean;
  handlers: LongPressHandlers;
}

export function useLongPress({
  enabled,
  onLongPress,
  delayMs = LONG_PRESS_DELAY_MS,
  moveThresholdPx = LONG_PRESS_MOVE_THRESHOLD_PX,
}: UseLongPressOptions): UseLongPressResult {
  const [pressing, setPressing] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const suppressResetTimerRef = useRef<number | undefined>(undefined);
  const activePointerIdRef = useRef<number | null>(null);
  const startPointRef = useRef<{ x: number; y: number } | null>(null);
  const suppressNextClickRef = useRef(false);
  const detachInterruptListenersRef = useRef<(() => void) | null>(null);
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;

  const clearSuppressTimer = useCallback(() => {
    window.clearTimeout(suppressResetTimerRef.current);
    suppressResetTimerRef.current = undefined;
  }, []);

  const detachInterruptListeners = useCallback(() => {
    detachInterruptListenersRef.current?.();
    detachInterruptListenersRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    detachInterruptListeners();
    activePointerIdRef.current = null;
    startPointRef.current = null;
    setPressing(false);
  }, [detachInterruptListeners]);

  useEffect(() => {
    if (!enabled) {
      cancel();
      suppressNextClickRef.current = false;
      clearSuppressTimer();
    }
  }, [cancel, clearSuppressTimer, enabled]);

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
      window.clearTimeout(suppressResetTimerRef.current);
      detachInterruptListeners();
    },
    [detachInterruptListeners],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled) return;
      if (!event.isPrimary) return;
      if (event.pointerType === 'mouse') return;
      if (
        event.target instanceof Element &&
        event.target.closest(INTERACTIVE_DESCENDANT_SELECTOR) !== null
      ) {
        return;
      }
      suppressNextClickRef.current = false;
      clearSuppressTimer();
      cancel();
      activePointerIdRef.current = event.pointerId;
      startPointRef.current = { x: event.clientX, y: event.clientY };
      setPressing(true);
      const handleInterrupt = () => cancel();
      window.addEventListener('blur', handleInterrupt);
      window.addEventListener('scroll', handleInterrupt, true);
      detachInterruptListenersRef.current = () => {
        window.removeEventListener('blur', handleInterrupt);
        window.removeEventListener('scroll', handleInterrupt, true);
      };
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        detachInterruptListeners();
        activePointerIdRef.current = null;
        startPointRef.current = null;
        setPressing(false);
        suppressNextClickRef.current = true;
        clearSuppressTimer();
        suppressResetTimerRef.current = window.setTimeout(() => {
          suppressNextClickRef.current = false;
          suppressResetTimerRef.current = undefined;
        }, SUPPRESS_CLICK_TIMEOUT_MS);
        if (
          typeof navigator !== 'undefined' &&
          typeof navigator.vibrate === 'function'
        ) {
          try {
            navigator.vibrate(10);
          } catch {
            // Ignore blocked vibration attempts on browsers that restrict it.
          }
        }
        onLongPressRef.current();
      }, delayMs);
    },
    [cancel, clearSuppressTimer, delayMs, detachInterruptListeners, enabled],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (
        activePointerIdRef.current === null ||
        event.pointerId !== activePointerIdRef.current ||
        !startPointRef.current
      ) {
        return;
      }
      const dx = event.clientX - startPointRef.current.x;
      const dy = event.clientY - startPointRef.current.y;
      if (Math.hypot(dx, dy) > moveThresholdPx) {
        cancel();
      }
    },
    [cancel, moveThresholdPx],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (
        activePointerIdRef.current !== null &&
        event.pointerId === activePointerIdRef.current
      ) {
        cancel();
      }
    },
    [cancel],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (
        activePointerIdRef.current !== null &&
        event.pointerId === activePointerIdRef.current
      ) {
        cancel();
      }
    },
    [cancel],
  );

  const onClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!suppressNextClickRef.current) return;
      suppressNextClickRef.current = false;
      clearSuppressTimer();
      event.preventDefault();
      event.stopPropagation();
    },
    [clearSuppressTimer],
  );

  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!enabled) return;
      if (activePointerIdRef.current !== null || suppressNextClickRef.current) {
        event.preventDefault();
      }
    },
    [enabled],
  );

  return {
    pressing,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClickCapture,
      onContextMenu,
    },
  };
}
