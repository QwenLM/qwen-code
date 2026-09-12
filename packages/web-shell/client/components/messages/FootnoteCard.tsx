import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { cssUrlValue } from '../../utils/cssUrlVar';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';
import knowledgeIcon from '../../assets/icons/knowledge.svg';
import type { FootnoteElement, FootnotePreview } from './rehype-footnote-cards';
import type {
  WebShellFootnoteIconResolver,
  WebShellFootnotePreviewMount,
} from '../../customization';
import { FootnotePreviewContent } from './FootnotePreviewContent';
import { isSafeImageSrc } from './Markdown';

export function FootnoteSup({
  node,
  children,
  linkComponent,
  iconResolver,
  mountPreview,
  ...props
}: ComponentProps<'sup'> &
  ExtraProps & {
    linkComponent?: Components['a'];
    iconResolver?: WebShellFootnoteIconResolver;
    mountPreview?: WebShellFootnotePreviewMount;
  }) {
  const notes = (node as FootnoteElement | undefined)?.data?.footnoteCards;
  return notes ? (
    <FootnoteCard
      id={props.id}
      notes={notes}
      linkComponent={linkComponent}
      iconResolver={iconResolver}
      mountPreview={mountPreview}
    />
  ) : (
    <sup {...props}>{children}</sup>
  );
}

export function FootnoteSection({
  node,
  children,
  sectionComponent,
  ...props
}: ComponentProps<'section'> &
  ExtraProps & { sectionComponent?: Components['section'] }) {
  if (
    (node as FootnoteElement | undefined)?.data?.hasVisibleFootnotes === false
  )
    return null;
  return sectionComponent ? (
    createElement(
      sectionComponent,
      typeof sectionComponent === 'string' ? props : { ...props, node },
      children,
    )
  ) : (
    <section {...props}>{children}</section>
  );
}

function FootnoteCard({
  id,
  notes,
  linkComponent,
  iconResolver,
  mountPreview,
}: {
  id?: string;
  notes: FootnotePreview[];
  linkComponent?: Components['a'];
  iconResolver?: WebShellFootnoteIconResolver;
  mountPreview?: WebShellFootnotePreviewMount;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinned = useRef(false);
  const customIcon = useMemo(() => {
    try {
      const icon = iconResolver?.(
        notes.map(({ linkNode: _linkNode, ...footnote }) => footnote),
      );
      return typeof icon === 'string' && isSafeImageSrc(icon)
        ? icon.trim()
        : undefined;
    } catch {
      return undefined;
    }
  }, [iconResolver, notes]);
  const index = Math.max(
    0,
    notes.findIndex((note) => note.id === selectedId),
  );

  function cancelTimer() {
    clearTimeout(timer.current);
  }
  function changeOpen(next: boolean) {
    cancelTimer();
    if (!next) pinned.current = false;
    if (next && !open) setSelectedId(undefined);
    setOpen(next);
  }
  function pinOpen() {
    pinned.current = true;
    cancelTimer();
  }
  function leave() {
    cancelTimer();
    if (pinned.current) return;
    timer.current = setTimeout(() => {
      if (
        !trigger.current?.matches(':focus-within') &&
        !content.current?.matches(':focus-within')
      ) {
        setOpen(false);
      }
    }, 200);
  }
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          id={id}
          type="button"
          data-web-shell-footnote-trigger=""
          className="mx-0.5 inline-flex h-5 items-center gap-1 rounded-full bg-muted px-1.5 align-middle text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={t('footnotes.references', { count: notes.length })}
          onPointerEnter={(event) => {
            if (event.pointerType === 'touch') return;
            cancelTimer();
            timer.current = setTimeout(() => changeOpen(true), 150);
          }}
          onPointerLeave={leave}
          onFocus={() => changeOpen(true)}
          onBlur={leave}
          onKeyDown={(event) => {
            if (!['Enter', ' ', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            changeOpen(true);
            requestAnimationFrame(() => {
              const target = content.current?.querySelector<HTMLElement>(
                'a[href], button:not(:disabled)',
              );
              (target ?? content.current)?.focus();
            });
          }}
          onClick={(event) => {
            event.preventDefault();
            pinOpen();
            changeOpen(true);
          }}
        >
          <span
            aria-hidden="true"
            className="inline-block size-4 shrink-0 bg-current"
            style={{
              maskImage: cssUrlValue(customIcon ?? knowledgeIcon),
              maskSize: 'contain',
              maskRepeat: 'no-repeat',
              maskPosition: 'center',
            }}
          />
          {notes.length > 1 ? notes.length : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={content}
        data-web-shell-footnote-card=""
        className="w-[360px] max-w-[calc(100vw-24px)] gap-3 rounded-2xl p-4 shadow-lg"
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        aria-label={t('footnotes.preview')}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={() => trigger.current?.focus()}
        onPointerEnter={cancelTimer}
        onPointerLeave={leave}
        onFocusCapture={cancelTimer}
        onBlurCapture={leave}
      >
        <FootnotePreviewContent
          notes={notes}
          index={index}
          mount={mountPreview}
          linkComponent={linkComponent}
        />
        {notes.length > 1 && (
          <div className="flex items-center justify-end gap-2 border-t border-border pt-2">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t('footnotes.previous')}
              disabled={index === 0}
              onClick={() => {
                pinOpen();
                setSelectedId(notes[index - 1].id);
              }}
            >
              <ChevronLeftIcon />
            </Button>
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {index + 1} / {notes.length}
            </span>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t('footnotes.next')}
              disabled={index === notes.length - 1}
              onClick={() => {
                pinOpen();
                setSelectedId(notes[index + 1].id);
              }}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
