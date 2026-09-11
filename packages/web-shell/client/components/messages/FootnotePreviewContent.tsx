import {
  createElement,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { Components } from 'react-markdown';
import type {
  WebShellFootnotePreviewHandle,
  WebShellFootnotePreviewInfo,
  WebShellFootnotePreviewMount,
} from '../../customization';
import { useI18n } from '../../i18n';
import { useExternalLinkOpener } from '../../hooks/useExternalLinkOpener';
import { cssUrlValue } from '../../utils/cssUrlVar';
import knowledgeIcon from '../../assets/icons/knowledge.svg';
import { ErrorBoundary } from '../ErrorBoundary';
import type { FootnotePreview } from './rehype-footnote-cards';

type PreviewData = Omit<WebShellFootnotePreviewInfo, 'sourceLink'>;

export function FootnotePreviewContent({
  notes,
  index,
  mount,
  linkComponent,
}: {
  notes: FootnotePreview[];
  index: number;
  mount?: WebShellFootnotePreviewMount;
  linkComponent?: Components['a'];
}) {
  const { t } = useI18n();
  const footnotes = useMemo(
    () => notes.map(({ linkNode: _linkNode, ...footnote }) => footnote),
    [notes],
  );
  const note = notes[index];
  const title = note.title || t('footnotes.note', { number: note.number });
  let hostname: string | undefined;
  try {
    hostname = note.href ? new URL(note.href).hostname : undefined;
  } catch {
    // Relative links and anchors have no source hostname.
  }
  const sourceLabel =
    note.source || hostname || t('footnotes.note', { number: note.number });
  const info = useMemo<PreviewData>(
    () => ({
      footnotes,
      footnote: footnotes[index],
      index,
      title,
      sourceLabel,
    }),
    [footnotes, index, title, sourceLabel],
  );
  const sourceLink = (
    <FootnoteSourceLink
      note={note}
      title={title}
      navigable={!!note.href && hostname !== 'citation.invalid'}
      linkComponent={linkComponent}
    />
  );
  const fallback = (
    <DefaultFootnoteContent
      note={note}
      sourceLabel={sourceLabel}
      sourceLink={sourceLink}
    />
  );
  if (!mount) return fallback;
  return (
    <ErrorBoundary
      label="footnote preview content"
      resetKeys={[mount, info]}
      fallback={fallback}
    >
      <MountedFootnoteContent
        mount={mount}
        info={info}
        sourceLink={sourceLink}
        fallback={fallback}
      />
    </ErrorBoundary>
  );
}

function FootnoteSourceLink({
  note,
  title,
  navigable,
  linkComponent,
}: {
  note: FootnotePreview;
  title: string;
  navigable: boolean;
  linkComponent?: Components['a'];
}) {
  const openExternalLink = useExternalLinkOpener();
  const className =
    'line-clamp-2 font-semibold break-words text-popover-foreground hover:underline';
  if (note.href && linkComponent) {
    return createElement(
      linkComponent,
      {
        className,
        href: note.href,
        title: note.source,
        target: '_blank',
        rel: 'noopener noreferrer',
        ...(typeof linkComponent === 'string' ? {} : { node: note.linkNode }),
      },
      title,
    );
  }
  return navigable ? (
    <a
      className={className}
      href={note.href}
      title={note.source}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => openExternalLink(event, note.href)}
    >
      {title}
    </a>
  ) : (
    <div className="line-clamp-2 font-semibold break-words">{title}</div>
  );
}

function DefaultFootnoteContent({
  note,
  sourceLabel,
  sourceLink,
}: {
  note: FootnotePreview;
  sourceLabel: string;
  sourceLink: ReactNode;
}) {
  const [failedImage, setFailedImage] = useState<string>();
  return (
    <>
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
        <span className="truncate">{sourceLabel}</span>
      </div>
      <div
        className="flex items-start gap-3"
        aria-live="polite"
        aria-atomic="true"
      >
        <div className="min-w-0 flex-1">
          {sourceLink}
          {note.summary && (
            <p
              data-web-shell-footnote-summary=""
              tabIndex={0}
              className="mt-1 max-h-48 overflow-y-auto overscroll-contain text-sm break-words text-muted-foreground"
            >
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
    </>
  );
}

function MountedFootnoteContent({
  mount,
  info,
  sourceLink,
  fallback,
}: {
  mount: WebShellFootnotePreviewMount;
  info: PreviewData;
  sourceLink: ReactNode;
  fallback: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const active = useRef<
    | {
        mount: WebShellFootnotePreviewMount;
        handle: WebShellFootnotePreviewHandle;
        container: HTMLElement;
        link: HTMLElement;
      }
    | undefined
  >(undefined);
  const [linkRoot, setLinkRoot] = useState<HTMLElement | null>();
  const dispose = useCallback(() => {
    const previous = active.current;
    active.current = undefined;
    if (!previous) return;
    try {
      previous.handle.dispose();
    } catch (error) {
      console.error('[web-shell] footnote preview cleanup failed:', error);
    } finally {
      previous.link.remove();
      previous.container.replaceChildren();
    }
  }, []);

  useLayoutEffect(() => {
    const target = container.current!;
    let pendingLink: HTMLElement | undefined;
    try {
      if (active.current?.mount !== mount) dispose();
      const existing = active.current;
      if (existing) {
        existing.handle.update({ ...info, sourceLink: existing.link });
        return;
      }
      // A declined page hides this container; each host mount needs layout.
      target.hidden = false;
      pendingLink = target.ownerDocument.createElement('span');
      pendingLink.dataset['webShellFootnoteSourceLink'] = '';
      const handle = mount(target, { ...info, sourceLink: pendingLink });
      if (handle == null) {
        pendingLink.remove();
        target.replaceChildren();
        target.hidden = true;
        setLinkRoot(null);
        return;
      }
      if (
        typeof handle.update !== 'function' ||
        typeof handle.dispose !== 'function'
      ) {
        if (typeof handle.dispose === 'function') handle.dispose();
        throw new Error(
          'Footnote preview mount must return update and dispose methods',
        );
      }
      active.current = { mount, handle, container: target, link: pendingLink };
      setLinkRoot(pendingLink);
    } catch (error) {
      dispose();
      pendingLink?.remove();
      target.replaceChildren();
      throw error;
    }
  }, [mount, info, dispose]);
  useLayoutEffect(() => dispose, [dispose]);

  return (
    <>
      {linkRoot === null && fallback}
      <div
        ref={container}
        hidden={linkRoot === null}
        tabIndex={0}
        data-web-shell-footnote-custom-content=""
        className="max-h-[min(50vh,320px)] overflow-y-auto overscroll-contain"
        aria-live="polite"
        aria-atomic="true"
      />
      {linkRoot && createPortal(sourceLink, linkRoot)}
    </>
  );
}
