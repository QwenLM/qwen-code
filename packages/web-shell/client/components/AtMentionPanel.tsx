import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import {
  FILE_PROVIDER_ID,
  sanitizeDisplayText,
  type AtMentionMenuState,
} from '../hooks/useAtMentionMenu';
import { cssUrlVar } from '../utils/cssUrlVar';
import styles from './ChatEditor.module.css';
import { isSafeImageSrc } from './messages/Markdown';

const AT_PANEL_THEME_VARS = [
  '--chat-editor-accent-color',
  '--chat-editor-text-primary',
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
  onSelectTab,
}: {
  menu: AtMentionMenuState;
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  onSelect: (index: number) => boolean;
  onAccept: (index?: number) => boolean;
  onBack: () => boolean;
  onSearch: (query: string) => boolean;
  onSelectTab: (tabId: string) => boolean;
}) {
  const { t } = useI18n();
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [anchorRect, setAnchorRect] = useState<{
    left: number;
    bottom: number;
    width: number;
    maxHeight: number;
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
      const computedStyle = getComputedStyle(anchor);
      const safeTop =
        Number.parseFloat(
          computedStyle.getPropertyValue('--web-shell-popover-safe-top'),
        ) || 48;
      const maxHeight = Math.max(96, Math.min(300, rect.top - safeTop - 8));
      const next = {
        left: Math.max(
          12,
          Math.min(rect.left + 16, window.innerWidth - panelWidth - 12),
        ),
        bottom: window.innerHeight - rect.top + 8,
        width: rect.width,
        maxHeight,
      };
      setAnchorRect((prev) => {
        if (
          prev &&
          prev.left === next.left &&
          prev.bottom === next.bottom &&
          prev.width === next.width &&
          prev.maxHeight === next.maxHeight
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

  const rows =
    menu.level === 'categories'
      ? menu.providers.map((provider) => ({
          id: provider.id,
          label: provider.label,
          labelTitle: provider.textValue,
          description: provider.description,
          trailing: '›',
          provider,
        }))
      : menu.items.map((item) => ({
          id: item.id,
          label: item.label,
          labelTitle: item.label,
          subtitle: item.subtitle,
          description:
            menu.selectedProviderId === FILE_PROVIDER_ID
              ? undefined
              : (item.description ?? item.detail),
          icon: item.icon,
          iconMode: item.iconMode,
          iconColor: item.iconColor,
          iconSpin: item.iconSpin,
          iconTooltip: item.iconTooltip,
          trailing:
            item.kind === 'directory' || item.kind === 'mcp-server' ? '›' : '',
          item,
        }));

  useEffect(() => {
    itemRefs.current.length = rows.length;
  }, [rows.length]);

  if (!anchorRect) return null;

  const selectedProvider = menu.providers.find(
    (provider) => provider.id === menu.selectedProviderId,
  );
  const panelTitle =
    menu.itemMode === 'mcpResources' && menu.mcpServerName
      ? (sanitizeDisplayText(menu.mcpServerName) ?? '[invalid]')
      : (selectedProvider?.label ?? '');
  const panelTitleText =
    menu.itemMode === 'mcpResources' && menu.mcpServerName
      ? (sanitizeDisplayText(menu.mcpServerName) ?? '[invalid]')
      : (selectedProvider?.textValue ?? '');
  const listboxLabel =
    menu.level === 'items'
      ? (selectedProvider?.textValue ?? t('at.menu'))
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
        data-at-mention-panel="true"
        style={
          {
            ...themeVars,
            left: anchorRect.left,
            bottom: anchorRect.bottom,
            '--at-anchor-width': `${anchorRect.width}px`,
            '--at-panel-max-height': `${anchorRect.maxHeight}px`,
          } as CSSProperties
        }
        role="region"
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
                aria-label={t('common.back')}
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
              <span className={styles.atPanelTitle} title={panelTitleText}>
                {panelTitle}
              </span>
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
            {menu.tabs && menu.tabs.length > 0 && (
              <div className={styles.atTabsWrap}>
                <button
                  type="button"
                  className={styles.atTabScrollButton}
                  aria-label="Previous tab"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    scrollTabs(tabsRef.current, 'previous');
                  }}
                >
                  ‹
                </button>
                <div ref={tabsRef} className={styles.atTabs} role="tablist">
                  {menu.tabs.map((tab) => {
                    const selected = tab.id === menu.selectedTabId;
                    const tabText =
                      tab.textValue ??
                      (typeof tab.label === 'string' ? tab.label : tab.id);
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        disabled={tab.disabled}
                        className={`${styles.atTab} ${
                          selected ? styles.atTabActive : ''
                        }`}
                        title={tabText}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onSelectTab(tab.id);
                        }}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className={styles.atTabScrollButton}
                  aria-label="Next tab"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    scrollTabs(tabsRef.current, 'next');
                  }}
                >
                  ›
                </button>
              </div>
            )}
          </div>
        )}
        <div
          id={listboxId}
          className={styles.atList}
          role={rows.length > 0 ? 'listbox' : undefined}
          aria-label={rows.length > 0 ? listboxLabel : undefined}
        >
          {menu.loading && rows.length === 0 ? (
            <div className={styles.atEmpty} role="status" aria-live="polite">
              {t('common.loading')}
            </div>
          ) : rows.length === 0 ? (
            <div className={styles.atEmpty} role="status" aria-live="polite">
              {t('common.noResults')}
            </div>
          ) : (
            rows.map((row, index) => {
              const selected = index === menu.selectedIndex;
              const provider =
                'item' in row
                  ? selectedProvider?.provider
                  : row.provider.provider;
              const customItem =
                'item' in row && provider?.renderItem
                  ? provider.renderItem({
                      item: row.item,
                      provider,
                      selected,
                    })
                  : undefined;
              return (
                <button
                  key={row.id}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  id={`at-mention-option-${index}`}
                  role="option"
                  aria-selected={selected}
                  className={`${styles.atItem} ${
                    selected ? styles.atItemActive : ''
                  } ${row.description ? '' : styles.atItemSingleLine}`}
                  style={
                    {
                      '--at-item-main-template': getAtItemMainTemplate(
                        getRowTextValue(row.label, row.labelTitle),
                        'subtitle' in row ? row.subtitle : undefined,
                      ),
                    } as CSSProperties
                  }
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
                  {customItem ?? (
                    <>
                      <span className={styles.atItemMain}>
                        <span className={styles.atItemLeading}>
                          {'icon' in row &&
                            row.icon &&
                            (row.iconMode === 'image' ? (
                              isSafeImageSrc(row.icon) && (
                                <img
                                  className={styles.atItemImageIcon}
                                  src={row.icon}
                                  title={row.iconTooltip}
                                  alt=""
                                  aria-hidden="true"
                                />
                              )
                            ) : (
                              <span
                                className={`${styles.atItemIcon} ${
                                  row.iconSpin ? styles.atItemIconSpin : ''
                                }`}
                                style={{
                                  ...cssUrlVar('--at-item-icon-url', row.icon),
                                  color: row.iconColor,
                                }}
                                title={row.iconTooltip}
                                aria-hidden="true"
                              />
                            ))}
                          <span
                            className={styles.atItemLabel}
                            title={row.labelTitle}
                          >
                            {row.label}
                          </span>
                        </span>
                        {'subtitle' in row && row.subtitle && (
                          <span
                            className={styles.atItemSubtitle}
                            title={row.subtitle}
                          >
                            {row.subtitle}
                          </span>
                        )}
                      </span>
                      {row.description && (
                        <span
                          className={styles.atItemDescription}
                          title={row.description}
                        >
                          {row.description}
                        </span>
                      )}
                    </>
                  )}
                  {row.trailing && (
                    <span className={styles.atItemTrailing} aria-hidden="true">
                      {row.trailing}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function scrollTabs(
  element: HTMLDivElement | null,
  direction: 'previous' | 'next',
): void {
  if (!element) return;
  const delta = Math.max(96, element.clientWidth * 0.75);
  element.scrollBy({
    left: direction === 'previous' ? -delta : delta,
    behavior: 'smooth',
  });
}

function getAtItemMainTemplate(
  label: string,
  subtitle: string | undefined,
): string {
  if (!subtitle) return 'minmax(0, 1fr)';
  const labelLength = getDisplayLength(label);
  const subtitleLength = getDisplayLength(subtitle);
  if (subtitleLength <= 12) return 'minmax(0, 1fr) max-content';
  if (labelLength <= 18) return 'max-content minmax(0, 1fr)';
  return 'minmax(0, 3fr) minmax(0, 2fr)';
}

function getRowTextValue(
  label: ReactNode,
  fallback: string | undefined,
): string {
  if (typeof label === 'string') return label;
  if (typeof label === 'number') return String(label);
  return fallback || '';
}

function getDisplayLength(value: string): number {
  return Array.from(value).reduce((total, char) => {
    return total + (char.charCodeAt(0) > 255 ? 2 : 1);
  }, 0);
}
