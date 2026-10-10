import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CopyIcon, FileCodeIcon } from 'lucide-react';
import { Button } from '../ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover';
import { useI18n } from '../../i18n';
import {
  writeClipboardText,
  warnClipboardWriteFailure,
} from '../../utils/clipboard';
import {
  getReplySelectionRange,
  getSelectedReplyContent,
} from '../../utils/selectionClipboard';

export interface SelectionCopyMenuProps {
  children: ReactNode;
  className: string;
  content: string;
  enabled: boolean;
}

export function SelectionCopyMenu({
  children,
  className,
  content,
  enabled,
}: SelectionCopyMenuProps) {
  const { t } = useI18n();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<{
    text: string;
    markdown: string;
    range: Range;
  } | null>(null);
  const anchor = useRef({ getBoundingClientRect: () => new DOMRect() });
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSelected(null), [content, enabled]);
  useEffect(() => {
    if (!selected) return;
    const body = bodyRef.current!;
    const document = body.ownerDocument;
    const close = () => setSelected(null);
    const onSelectionChange = () => {
      const menu = menuRef.current;
      const root = menu?.getRootNode() as Document | ShadowRoot | undefined;
      if (menu?.contains(root?.activeElement ?? null)) return;
      const range = getReplySelectionRange(body);
      if (
        !range ||
        range.compareBoundaryPoints(Range.START_TO_START, selected.range) !==
          0 ||
        range.compareBoundaryPoints(Range.END_TO_END, selected.range) !== 0
      )
        close();
    };
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('scroll', close, true);
    document.defaultView?.addEventListener('resize', close);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('scroll', close, true);
      document.defaultView?.removeEventListener('resize', close);
    };
  }, [selected]);

  const showSelection = useCallback(() => {
    const body = bodyRef.current;
    const range = enabled && body ? getReplySelectionRange(body) : null;
    const value = range && body ? getSelectedReplyContent(body, range) : null;
    if (!range || !value) {
      setSelected(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    anchor.current = { getBoundingClientRect: () => rect };
    setSelected({ ...value, range: range.cloneRange() });
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    const body = bodyRef.current!;
    const document = body.ownerDocument;
    let selecting = false;
    let selectingTable = false;
    const onPointerDown = (event: PointerEvent) => {
      selectingTable = event
        .composedPath()
        .some(
          (node) =>
            node instanceof Element &&
            node.hasAttribute('data-selection-copy-table'),
        );
      selecting =
        event.pointerType === 'mouse' &&
        event.button === 0 &&
        event.composedPath().includes(body) &&
        !selectingTable;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      if (selectingTable) {
        selectingTable = false;
        setSelected(null);
        return;
      }
      const belongsToReply = selecting || event.composedPath().includes(body);
      selecting = false;
      if (belongsToReply) showSelection();
    };
    const cancel = () => {
      selecting = false;
      selectingTable = false;
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', cancel, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', cancel, true);
    };
  }, [enabled, showSelection]);
  const copy = (value: string, button: HTMLButtonElement) => {
    button.focus({ preventScroll: true });
    void writeClipboardText(value)
      .then(() => setSelected(null))
      .catch((error: unknown) => {
        const body = bodyRef.current;
        if (body && menuRef.current && selected) {
          const root = body.getRootNode() as Document | ShadowRoot;
          const selection =
            (root as Document).getSelection?.() ??
            body.ownerDocument.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(selected.range);
        }
        warnClipboardWriteFailure(error);
      });
  };

  return (
    <div ref={bodyRef} className={className}>
      {children}
      <Popover
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <PopoverAnchor virtualRef={anchor} />
        {selected && (
          <PopoverContent
            ref={menuRef}
            className="w-auto gap-0.5 p-1"
            side="top"
            aria-label={t('assistant.selectionCopy')}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              if (event.pointerType === 'mouse') event.preventDefault();
            }}
          >
            <Button
              variant="ghost"
              className="justify-start font-normal"
              onClick={(event) => copy(selected.text, event.currentTarget)}
            >
              <CopyIcon strokeWidth={1.5} />
              {t('assistant.copyPlainText')}
            </Button>
            <Button
              variant="ghost"
              className="justify-start font-normal"
              onClick={(event) => copy(selected.markdown, event.currentTarget)}
            >
              <FileCodeIcon strokeWidth={1.5} />
              {t('assistant.copyMarkdown')}
            </Button>
          </PopoverContent>
        )}
      </Popover>
    </div>
  );
}
