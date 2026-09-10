import {
  createElement,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useExternalLinkOpener } from '../../hooks/useExternalLinkOpener';
import { cssUrlValue } from '../../utils/cssUrlVar';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';
import knowledgeIcon from '../../assets/icons/knowledge.svg';
import type { FootnoteElement, FootnotePreview } from './rehype-footnote-cards';

export type FootnoteSourcesChangeHandler = (notes: FootnotePreview[]) => void;

export function FootnoteSup({
  node,
  children,
  linkComponent,
  ...props
}: ComponentProps<'sup'> & ExtraProps & { linkComponent?: Components['a'] }) {
  const notes = (node as FootnoteElement | undefined)?.data?.footnoteCards;
  return notes ? (
    <FootnoteCard id={props.id} notes={notes} linkComponent={linkComponent} />
  ) : (
    <sup {...props}>{children}</sup>
  );
}

export function FootnoteSection({
  node,
  children,
  linkComponent,
  onSourcesChange,
  sectionComponent,
  ...props
}: ComponentProps<'section'> &
  ExtraProps & {
    linkComponent?: Components['a'];
    onSourcesChange?: FootnoteSourcesChangeHandler;
    sectionComponent?: Components['section'];
  }) {
  const data = (node as FootnoteElement | undefined)?.data;
  const notes = data?.footnoteSourcesFooter ? data.footnoteCards : undefined;
  useEffect(() => {
    if (!onSourcesChange) return;
    onSourcesChange(notes ?? []);
    return () => onSourcesChange([]);
  }, [notes, onSourcesChange]);
  const section = sectionComponent ? (
    createElement(
      sectionComponent,
      typeof sectionComponent === 'string' ? props : { ...props, node },
      children,
    )
  ) : (
    <section {...props}>{children}</section>
  );
  if (!notes?.length) return section;
  const visibleFootnotes = data?.hasVisibleFootnotes ? section : null;
  if (onSourcesChange) return visibleFootnotes;
  return (
    <>
      {visibleFootnotes}
      <div data-web-shell-footnote-sources="" className="mt-4 flex">
        <FootnoteCard
          notes={notes}
          variant="footer"
          linkComponent={linkComponent}
        />
      </div>
    </>
  );
}

export function FootnoteSources({
  notes,
  linkComponent,
}: {
  notes: FootnotePreview[];
  linkComponent?: Components['a'];
}) {
  if (!notes.length) return null;
  return (
    <FootnoteCard
      notes={notes}
      variant="footer"
      linkComponent={linkComponent}
    />
  );
}

function FootnoteCard({
  id,
  notes,
  variant = 'inline',
  linkComponent,
}: {
  id?: string;
  notes: FootnotePreview[];
  variant?: 'inline' | 'footer';
  linkComponent?: Components['a'];
}) {
  const { t } = useI18n();
  const openExternalLink = useExternalLinkOpener();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [failedImage, setFailedImage] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinned = useRef(false);
  const index = Math.max(
    0,
    notes.findIndex((note) => note.id === selectedId),
  );
  const note = notes[index];
  const title = note.title || t('footnotes.note', { number: note.number });
  let hostname: string | undefined;
  try {
    hostname = note.href ? new URL(note.href).hostname : undefined;
  } catch {
    // Relative links and anchors have no source hostname.
  }
  const defaultLink = note.href && hostname !== 'citation.invalid';

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
          data-web-shell-footnote-trigger={
            variant === 'inline' ? '' : undefined
          }
          data-web-shell-footnote-sources-trigger={
            variant === 'footer' ? '' : undefined
          }
          className={
            variant === 'footer'
              ? 'inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring'
              : 'mx-0.5 inline-flex h-5 items-center gap-1 rounded-full bg-muted px-1.5 align-baseline text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring'
          }
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
              maskImage: cssUrlValue(knowledgeIcon),
              maskSize: 'contain',
              maskRepeat: 'no-repeat',
            }}
          />
          {variant === 'footer'
            ? t('footnotes.citations', { count: notes.length })
            : notes.length > 1
              ? notes.length
              : null}
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
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            aria-hidden="true"
            className="size-4 shrink-0 bg-current"
            style={{
              maskImage: cssUrlValue(knowledgeIcon),
              maskSize: 'contain',
              maskRepeat: 'no-repeat',
            }}
          />
          <span className="truncate">
            {note.source ||
              hostname ||
              t('footnotes.note', { number: note.number })}
          </span>
        </div>
        <div
          className="flex items-start gap-3"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="min-w-0 flex-1">
            {note.href && linkComponent ? (
              createElement(
                linkComponent,
                {
                  className:
                    'line-clamp-2 font-semibold break-words text-popover-foreground hover:underline',
                  href: note.href,
                  title: note.source,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  ...(typeof linkComponent === 'string'
                    ? {}
                    : { node: note.linkNode }),
                },
                title,
              )
            ) : defaultLink ? (
              <a
                className="line-clamp-2 font-semibold break-words text-popover-foreground hover:underline"
                href={note.href}
                title={note.source}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => openExternalLink(event, note.href)}
              >
                {title}
              </a>
            ) : (
              <div className="line-clamp-2 font-semibold break-words">
                {title}
              </div>
            )}
            {note.summary && (
              <p className="mt-1 line-clamp-3 text-sm break-words text-muted-foreground">
                {note.summary}
              </p>
            )}
          </div>
          {note.image && note.image !== failedImage && (
            <img
              key={note.image}
              src={note.image}
              alt=""
              className="size-16 shrink-0 rounded-lg object-cover"
              onError={() => setFailedImage(note.image)}
            />
          )}
        </div>
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
