import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentRef,
  type ReactElement,
} from 'react';
import type { ContextUsageControls } from '../hooks/useContextUsageControls';
import { useI18n } from '../i18n';
import { getContextUsageLevel } from '../utils/contextUsage';
import { ContextCompressionFeedback } from './ContextCompressionFeedback';
import { Button } from './ui/button';
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover';
import styles from './ChatEditor.module.css';

export function ContextUsagePopover({
  tokenCount,
  contextWindow,
  controls,
  onOpenDetails,
  showSnapshotHint,
  children,
}: {
  tokenCount: number;
  contextWindow: number;
  controls?: Pick<
    ContextUsageControls,
    'canCompress' | 'compressing' | 'result' | 'compress'
  >;
  onOpenDetails?: () => void;
  showSnapshotHint: boolean;
  children: ReactElement;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  const anchorRef = useRef<ComponentRef<typeof PopoverAnchor>>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const focusOnOpen = useRef(false);
  const restoreFocus = useRef(false);
  const suppressFocusOpen = useRef(false);
  const known = tokenCount > 0 && contextWindow > 0;
  const percentage = known ? (tokenCount / contextWindow) * 100 : 0;

  useEffect(
    () => () => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    },
    [],
  );
  const cancelClose = () => clearTimeout(closeTimer.current);
  const close = () => {
    clearTimeout(openTimer.current);
    cancelClose();
    setOpen(false);
  };
  const containsFocus = (target: EventTarget | null) =>
    target instanceof Node &&
    (anchorRef.current?.contains(target) ||
      contentRef.current?.contains(target));
  const getActiveElement = () => {
    let active = anchorRef.current?.ownerDocument.activeElement ?? null;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  };
  const closeAfterDelay = () => {
    clearTimeout(openTimer.current);
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!containsFocus(getActiveElement())) close();
    }, 150);
  };
  const enterActions = () => {
    clearTimeout(openTimer.current);
    cancelClose();
    if (contentRef.current) {
      const first = contentRef.current.querySelector<HTMLButtonElement>(
        'button:not(:disabled)',
      );
      (first ?? contentRef.current)?.focus();
    } else {
      focusOnOpen.current = true;
    }
    setOpen(true);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
    >
      <PopoverAnchor
        asChild
        ref={anchorRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onPointerEnter={(event) => {
          if (event.pointerType === 'touch') return;
          cancelClose();
          clearTimeout(openTimer.current);
          openTimer.current = setTimeout(() => setOpen(true), 300);
        }}
        onPointerLeave={closeAfterDelay}
        onFocus={() => {
          clearTimeout(openTimer.current);
          cancelClose();
          if (!suppressFocusOpen.current) setOpen(true);
        }}
        onBlur={(event) => {
          if (!containsFocus(event.relatedTarget)) closeAfterDelay();
        }}
        onClick={close}
        onKeyDown={(event) => {
          if (
            event.key === 'ArrowDown' ||
            (open && event.key === 'Tab' && !event.shiftKey)
          ) {
            event.preventDefault();
            enterActions();
          } else if (event.key === 'Escape') close();
        }}
      >
        {children}
      </PopoverAnchor>
      <PopoverContent
        id={id}
        ref={contentRef}
        side="top"
        sideOffset={4}
        collisionPadding={12}
        showArrow
        className={`${styles.contextTooltip} text-xs`}
        data-web-shell-context-popover
        aria-label={t('contextUsage.title')}
        onOpenAutoFocus={(event) => {
          if (!focusOnOpen.current) event.preventDefault();
          focusOnOpen.current = false;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (restoreFocus.current) {
            restoreFocus.current = false;
            const activeElement = getActiveElement();
            if (
              activeElement &&
              activeElement !== anchorRef.current?.ownerDocument.body
            )
              return;
            suppressFocusOpen.current = true;
            anchorRef.current?.focus({ preventScroll: true });
            suppressFocusOpen.current = false;
          }
        }}
        onEscapeKeyDown={() => {
          restoreFocus.current = Boolean(
            contentRef.current?.contains(getActiveElement()),
          );
        }}
        onFocusOutside={(event) => {
          if (containsFocus(event.target)) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Tab') event.stopPropagation();
        }}
        onPointerEnter={cancelClose}
        onPointerLeave={closeAfterDelay}
        onFocus={cancelClose}
        onBlur={(event) => {
          if (!containsFocus(event.relatedTarget)) closeAfterDelay();
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.contextTooltipHeader}>
          <span>{t('contextUsage.title')}</span>
          {known && <strong>{percentage.toFixed(1)}%</strong>}
        </div>
        {known && (
          <>
            <div className={styles.contextTooltipMeter} aria-hidden="true">
              <span
                data-level={getContextUsageLevel(percentage)}
                style={{ width: `${Math.min(percentage, 100)}%` }}
              />
            </div>
            <dl className={styles.contextTooltipStats}>
              <dt>{t('contextUsage.used')}</dt>
              <dd>
                {tokenCount.toLocaleString()} {t('contextUsage.tokens')}
              </dd>
              <dt>{t('contextUsage.contextWindow')}</dt>
              <dd>
                {contextWindow.toLocaleString()} {t('contextUsage.tokens')}
              </dd>
              <dt>{t('contextUsage.remaining')}</dt>
              <dd>
                {Math.max(0, contextWindow - tokenCount).toLocaleString()}{' '}
                {t('contextUsage.tokens')}
              </dd>
            </dl>
          </>
        )}
        <ContextCompressionFeedback
          controls={controls}
          className="text-muted-foreground [&[role=alert]]:text-destructive"
        />
        {(controls || onOpenDetails) && (
          <div className="flex items-center gap-2 border-t pt-2">
            {controls && (
              <span
                title={
                  !controls.canCompress && !controls.compressing
                    ? t('contextUsage.compressUnavailable')
                    : undefined
                }
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!controls.canCompress}
                  onClick={() => void controls.compress()}
                >
                  {t(
                    controls.compressing
                      ? 'contextUsage.compressing'
                      : 'contextUsage.compress',
                  )}
                </Button>
              </span>
            )}
            {onOpenDetails && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  close();
                  onOpenDetails();
                }}
              >
                {t('contextUsage.viewDetails')}
              </Button>
            )}
          </div>
        )}
        {showSnapshotHint && (
          <div className="text-muted-foreground">
            {t('contextUsage.viewInConversation')}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
