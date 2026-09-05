import { useCallback } from 'react';
import type { MouseEvent } from 'react';
import { useI18n } from '../i18n';
import { requestToast } from '../components/ToastHost';
import { extractErrorDetail } from '../utils/errorDetail';
import {
  isDesktopShell,
  isExternalOpenUrl,
  openExternalUrl,
} from '../utils/externalOpen';

/**
 * Opens external link clicks through the shell's explicit desktop opener.
 *
 * The desktop webview's implicit `target="_blank"` handling can silently
 * drop new-window requests, so anchored external URLs should be routed
 * through this handler in the packaged shell; failures surface as error
 * toasts. Plain browsers keep native anchor behavior (the handler is a
 * no-op there).
 */
export function useExternalLinkOpener() {
  const { t } = useI18n();
  return useCallback(
    (event: MouseEvent<HTMLAnchorElement>, url: string | undefined) => {
      if (!url || !isExternalOpenUrl(url) || !isDesktopShell()) return;
      event.preventDefault();
      openExternalUrl(url).catch((error: unknown) => {
        requestToast(
          'error',
          t('common.openFailed', { message: extractErrorDetail(error) }),
        );
      });
    },
    [t],
  );
}
