import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useWebShellCustomization,
  type WebShellSource,
} from '../../customization';
import { useI18n } from '../../i18n';
import { cssUrlValue } from '../../utils/cssUrlVar';
import knowledgeIcon from '../../assets/icons/knowledge.svg';
import { isSafeImageSrc } from '../messages/Markdown';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { SourceList } from './SourceList';

export function TurnSources({
  sources,
  onOpen,
}: {
  sources: readonly WebShellSource[];
  onOpen?: (source: WebShellSource) => void;
}) {
  const { t } = useI18n();
  const { getAssistantSourcesIcon } = useWebShellCustomization();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const icon = useMemo(() => {
    try {
      const value = getAssistantSourcesIcon?.(sources);
      return typeof value === 'string' && isSafeImageSrc(value)
        ? value.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }, [getAssistantSourcesIcon, sources]);
  const cancel = () => clearTimeout(timer.current);
  const show = () => {
    cancel();
    setOpen(true);
  };
  const leave = () => {
    cancel();
    timer.current = setTimeout(() => {
      if (
        !trigger.current?.matches(':focus-within') &&
        !content.current?.matches(':focus-within')
      )
        setOpen(false);
    }, 200);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!sources.length) return null;
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        cancel();
        setOpen(value);
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          type="button"
          data-web-shell-turn-sources-trigger=""
          className="inline-flex h-5 items-center gap-1 rounded-[5px] px-1 text-[11px] leading-[1.4] text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring"
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
              content.current
                ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
                ?.focus(),
            );
          }}
        >
          <span
            aria-hidden="true"
            className={`size-3.5 shrink-0 bg-current ${icon ? '' : '-translate-y-px'}`}
            style={{
              maskImage: cssUrlValue(icon ?? knowledgeIcon),
              maskSize: 'contain',
              maskPosition: 'center',
              maskRepeat: 'no-repeat',
            }}
          />
          {t('sources.count', { count: sources.length })}
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={content}
        data-web-shell-turn-sources=""
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="w-[360px] max-w-[calc(100vw-24px)] rounded-2xl p-4"
        aria-label={t('sources.currentTurn')}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={() => trigger.current?.focus()}
        onPointerEnter={cancel}
        onPointerLeave={leave}
        onFocusCapture={cancel}
        onBlurCapture={leave}
      >
        <div className="text-xs text-muted-foreground">
          {t('sources.currentTurn')}
        </div>
        <div
          className="max-h-[min(50vh,320px)] overflow-y-auto overscroll-contain"
          tabIndex={0}
        >
          <SourceList
            entries={sources}
            onOpen={
              onOpen
                ? (source) => {
                    onOpen(source);
                    setOpen(false);
                  }
                : undefined
            }
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
