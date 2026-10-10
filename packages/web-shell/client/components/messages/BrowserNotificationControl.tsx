import { useEffect, useRef, useState } from 'react';
import {
  Bell,
  BellOff,
  BellRing,
  ChevronDownIcon,
  CircleCheckIcon,
} from 'lucide-react';
import { useBrowserNotificationSettings } from '../../browser-turn-notifications';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '../ui/popover';

export function BrowserNotificationControl() {
  const settings = useBrowserNotificationSettings();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestPermissionOnce = settings?.requestPermissionOnce;
  useEffect(() => requestPermissionOnce?.(), [requestPermissionOnce]);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!settings) return null;

  const enabled = settings.enabled && settings.permission === 'granted';
  const canAuthorize =
    settings.permission === 'default' || settings.permission === 'granted';
  const status = settings.pending
    ? 'requesting'
    : settings.permission === 'unavailable'
      ? 'unavailable'
      : settings.permission === 'denied'
        ? 'denied'
        : settings.error
          ? 'error'
          : enabled
            ? 'helpEnabled'
            : settings.permission === 'default'
              ? 'helpWaiting'
              : 'disabled';
  const Icon = enabled
    ? BellRing
    : settings.permission === 'default'
      ? Bell
      : BellOff;
  const cancelClose = () => clearTimeout(timer.current);
  const show = () => {
    cancelClose();
    settings.refreshPermission();
    setOpen(true);
  };
  const leave = () => {
    cancelClose();
    timer.current = setTimeout(() => {
      if (
        !trigger.current?.matches(':focus-within') &&
        !content.current?.matches(':focus-within')
      )
        setOpen(false);
    }, 200);
  };

  return (
    <span
      className="ml-auto inline-flex shrink-0"
      data-approval-shortcuts-ignore
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Popover
        open={open}
        onOpenChange={(next) => {
          cancelClose();
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            ref={trigger}
            type="button"
            variant="ghost"
            size="icon-xs"
            className={enabled ? 'text-primary' : 'text-muted-foreground'}
            aria-label={t('browserNotifications.label')}
            aria-pressed={enabled}
            title={t(`browserNotifications.${status}`)}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'touch') show();
            }}
            onPointerLeave={leave}
            onFocus={show}
            onBlur={leave}
            onClick={(event) => {
              event.preventDefault();
              show();
            }}
            onKeyDown={(event) => {
              if (!['Enter', ' ', 'ArrowDown'].includes(event.key)) return;
              event.preventDefault();
              show();
              requestAnimationFrame(() =>
                content.current?.focus({ preventScroll: true }),
              );
            }}
          >
            <Icon aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          ref={content}
          data-web-shell-notification-help
          align="end"
          side="top"
          collisionPadding={12}
          className="max-h-[min(70vh,520px,var(--radix-popover-content-available-height))] w-[360px] max-w-[calc(100vw-24px)] gap-3 overflow-auto p-4 text-xs leading-5"
          aria-label={t('browserNotifications.label')}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={() =>
            trigger.current?.focus({ preventScroll: true })
          }
          onPointerEnter={cancelClose}
          onPointerLeave={leave}
          onFocusCapture={cancelClose}
          onBlurCapture={leave}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <PopoverTitle className="text-base font-semibold">
            {t('browserNotifications.label')}
          </PopoverTitle>
          <div role="status">
            {status === 'helpEnabled' ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled
                className="w-full disabled:opacity-100"
              >
                <CircleCheckIcon
                  aria-hidden="true"
                  className="text-[var(--success-color)]"
                />
                {t('browserNotifications.helpEnabled')}
              </Button>
            ) : (
              <p>{t(`browserNotifications.${status}`)}</p>
            )}
          </div>
          {!enabled && (
            <Button
              type="button"
              size="sm"
              disabled={!canAuthorize || settings.pending}
              onClick={() => void settings.setEnabled(true)}
            >
              {t(
                settings.permission === 'granted'
                  ? 'browserNotifications.enable'
                  : 'browserNotifications.allow',
              )}
            </Button>
          )}
          <p>{t('browserNotifications.helpWhen')}</p>
          <p className="text-muted-foreground">
            {t('browserNotifications.helpSystem')}
          </p>
          <details className="group shrink-0">
            <summary className="flex cursor-pointer list-none items-center gap-1 font-medium [&::-webkit-details-marker]:hidden">
              macOS
              <ChevronDownIcon
                aria-hidden="true"
                className="size-3.5 transition-transform group-open:rotate-180"
              />
            </summary>
            <p className="mt-1 text-muted-foreground">
              {t('browserNotifications.helpMac')}
            </p>
          </details>
          <details className="group shrink-0">
            <summary className="flex cursor-pointer list-none items-center gap-1 font-medium [&::-webkit-details-marker]:hidden">
              Windows
              <ChevronDownIcon
                aria-hidden="true"
                className="size-3.5 transition-transform group-open:rotate-180"
              />
            </summary>
            <p className="mt-1 text-muted-foreground">
              {t('browserNotifications.helpWindows')}
            </p>
          </details>
        </PopoverContent>
      </Popover>
    </span>
  );
}
