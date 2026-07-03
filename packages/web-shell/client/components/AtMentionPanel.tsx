import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import {
  FILE_PROVIDER_ID,
  sanitizeDisplayText,
  type AtMentionMenuState,
} from '../hooks/useAtMentionMenu';
import styles from './ChatEditor.module.css';

const AT_PANEL_THEME_VARS = [
  '--chat-editor-accent-color',
  '--accent',
  '--background',
  '--foreground',
  '--muted-foreground',
  '--chat-editor-border-color',
  '--font-sans',
];

export function AtMentionPanel({
  menu,
  anchorRef,
  panelRef,
  onSelect,
  onAccept,
  onBack,
  onSearch,
}: {
  menu: AtMentionMenuState;
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  onSelect: (index: number) => boolean;
  onAccept: (index?: number) => boolean;
  onBack: () => boolean;
  onSearch: (query: string) => boolean;
}) {
  const { t } = useI18n();
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [anchorRect, setAnchorRect] = useState<{
    left: number;
    bottom: number;
    width: number;
  } | null>(null);
  const [themeVars, setThemeVars] = useState<CSSProperties>({});

  useEffect(() => {
    itemRefs.current[menu.selectedIndex]?.scrollIntoView({
      block: 'nearest',
    });
  }, [menu.level, menu.selectedIndex]);

  useEffect(() => {
    if (
      menu.level !== 'items' ||
      menu.inputMode !== 'search' ||
      document.activeElement === searchInputRef.current
    ) {
      return;
    }
    const focusSearch = () => searchInputRef.current?.focus();
    const frame = window.requestAnimationFrame(focusSearch);
    const timer = window.setTimeout(focusSearch, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [menu.inputMode, menu.level, menu.selectedProviderId]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return undefined;

    const computedStyle = getComputedStyle(anchor);
    setThemeVars(
      Object.fromEntries(
        AT_PANEL_THEME_VARS.map((name) => [
          name,
          computedStyle.getPropertyValue(name),
        ]),
      ) as CSSProperties,
    );
  }, [anchorRef]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return undefined;
    let frame: number | null = null;

    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect();
      const panelWidth = panelRef.current?.offsetWidth ?? 360;
      const next = {
        left: Math.max(
          12,
          Math.min(rect.left + 16, window.innerWidth - panelWidth - 12),
        ),
        bottom: window.innerHeight - rect.top + 8,
        width: rect.width,
      };
      setAnchorRect((prev) => {
        if (
          prev &&
          prev.left === next.left &&
          prev.bottom === next.bottom &&
          prev.width === next.width
        ) {
          return prev;
        }
        return next;
      });
    };
    const scheduleUpdatePosition = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        updatePosition();
      });
    };

    updatePosition();
    const resizeObserver = new ResizeObserver(scheduleUpdatePosition);
    resizeObserver.observe(anchor);
    window.addEventListener('resize', scheduleUpdatePosition);
    window.addEventListener('scroll', scheduleUpdatePosition, true);
    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      resizeObserver.disconnect();
      window.removeEventListener('resize', scheduleUpdatePosition);
      window.removeEventListener('scroll', scheduleUpdatePosition, true);
    };
  }, [anchorRef, panelRef]);

  if (!anchorRect) return null;

  const rows =
    menu.level === 'categories'
      ? menu.providers.map((provider) => ({
          id: provider.id,
          label: provider.label,
          description: provider.description,
          trailing: '›',
        }))
      : menu.items.map((item) => ({
          id: item.id,
          label: item.label,
          description:
            menu.selectedProviderId === FILE_PROVIDER_ID
              ? undefined
              : (item.description ?? item.detail),
          trailing:
            item.kind === 'directory' || item.kind === 'mcp-server' ? '›' : '',
        }));

  const selectedProvider = menu.providers.find(
    (provider) => provider.id === menu.selectedProviderId,
  );
  const panelTitle =
    menu.itemMode === 'mcpResources' && menu.mcpServerName
      ? (sanitizeDisplayText(menu.mcpServerName) ?? '[invalid]')
      : (selectedProvider?.label ?? '');
  const listboxLabel =
    menu.level === 'items'
      ? (selectedProvider?.label ?? t('at.menu'))
      : t('at.menu');
  const listboxId = 'at-mention-listbox';
  const activeOptionId =
    menu.selectedIndex >= 0 && menu.selectedIndex < rows.length
      ? `at-mention-option-${menu.selectedIndex}`
      : undefined;

  return createPortal(
    <div className={styles.atPortalLayer} style={themeVars}>
      <div
        ref={panelRef}
        className={styles.atPanel}
        style={
          {
            ...themeVars,
            left: anchorRect.left,
            bottom: anchorRect.bottom,
            '--at-anchor-width': `${anchorRect.width}px`,
          } as CSSProperties
        }
        role="dialog"
        aria-label={listboxLabel}
        onMouseDown={(event) => {
          if (event.target instanceof HTMLInputElement) return;
          event.preventDefault();
        }}
      >
        {menu.level === 'items' && (
          <div className={styles.atPanelHeaderWrap}>
            <div className={styles.atPanelHeader}>
              <button
                type="button"
                className={styles.atBackButton}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onBack();
                }}
              >
                ‹
              </button>
              <span className={styles.atPanelTitle}>{panelTitle}</span>
            </div>
            <input
              ref={searchInputRef}
              className={styles.atSearchInput}
              value={menu.query}
              placeholder={t('common.search')}
              aria-label={t('common.search')}
              aria-controls={listboxId}
              aria-activedescendant={activeOptionId}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onSearch(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229
                ) {
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  onBack();
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  event.stopPropagation();
                  onAccept();
                } else if (
                  event.key === 'Tab' &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  onAccept();
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  event.stopPropagation();
                  if (rows.length === 0) return;
                  onSelect(Math.max(0, menu.selectedIndex - 1));
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  event.stopPropagation();
                  if (rows.length === 0) return;
                  onSelect(Math.min(rows.length - 1, menu.selectedIndex + 1));
                }
              }}
            />
          </div>
        )}
        <div
          id={listboxId}
          className={styles.atList}
          role={rows.length > 0 ? 'listbox' : undefined}
          aria-label={rows.length > 0 ? listboxLabel : undefined}
        >
          {menu.loading && rows.length === 0 ? (
            <div className={styles.atEmpty}>{t('common.loading')}</div>
          ) : rows.length === 0 ? (
            <div className={styles.atEmpty}>{t('common.noResults')}</div>
          ) : (
            rows.map((row, index) => (
              <button
                key={row.id}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                type="button"
                id={`at-mention-option-${index}`}
                role="option"
                aria-selected={index === menu.selectedIndex}
                className={`${styles.atItem} ${
                  index === menu.selectedIndex ? styles.atItemActive : ''
                } ${row.description ? '' : styles.atItemSingleLine}`}
                onMouseEnter={() => onSelect(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onAccept(index);
                }}
              >
                <span className={styles.atItemLabel}>{row.label}</span>
                {row.description && (
                  <span className={styles.atItemDescription}>
                    {row.description}
                  </span>
                )}
                {row.trailing && (
                  <span className={styles.atItemTrailing}>{row.trailing}</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
