import { useEffect, useState } from 'react';
import { TOUCH_COMPOSER_QUERY } from '../../hooks/useIsTouchComposer';

// Match coarse primary pointers (phones, tablets, and Apple Pencil hover iPads)
// without tripping on headless Linux desktop Chromium which reports
// `hover: none` alongside `pointer: fine`.
export const TOUCH_SIDEBAR_MEDIA_QUERY = '(pointer: coarse)';

export interface TouchSidebarActionsState {
  isTouchActions: boolean;
  useActionSheet: boolean;
}

function matchesTouchSidebarMedia(): boolean {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return false;
  }
  return (
    window.matchMedia(TOUCH_SIDEBAR_MEDIA_QUERY).matches ||
    window.matchMedia(TOUCH_COMPOSER_QUERY).matches
  );
}

export function useTouchSidebarActions(
  mobileOpen = false,
): TouchSidebarActionsState {
  const [matchesTouchMedia, setMatchesTouchMedia] = useState(
    matchesTouchSidebarMedia,
  );

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    ) {
      return;
    }
    const broadMedia = window.matchMedia(TOUCH_SIDEBAR_MEDIA_QUERY);
    const legacyMedia = window.matchMedia(TOUCH_COMPOSER_QUERY);
    let broadMatches = broadMedia.matches;
    let legacyMatches = legacyMedia.matches;
    const sync = () => setMatchesTouchMedia(broadMatches || legacyMatches);
    sync();
    const onBroadChange = (event: MediaQueryListEvent) => {
      broadMatches = event.matches;
      sync();
    };
    const onLegacyChange = (event: MediaQueryListEvent) => {
      legacyMatches = event.matches;
      sync();
    };
    const subscribe = (
      mql: MediaQueryList,
      listener: (event: MediaQueryListEvent) => void,
    ) => {
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', listener);
        return () => mql.removeEventListener('change', listener);
      }
      mql.addListener?.(listener);
      return () => mql.removeListener?.(listener);
    };
    const unsubscribeBroad = subscribe(broadMedia, onBroadChange);
    const unsubscribeLegacy = subscribe(legacyMedia, onLegacyChange);
    return () => {
      unsubscribeBroad();
      unsubscribeLegacy();
    };
  }, []);

  const isTouchActions = mobileOpen || matchesTouchMedia;
  return {
    isTouchActions,
    useActionSheet: isTouchActions,
  };
}
