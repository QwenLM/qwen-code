/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decodePasteBytes, type ScrollBoxRenderable } from '@opentui/core';
import { usePaste, useTerminalDimensions } from '@opentui/react';
import open from 'open';
import type { ExtensionManager } from '@qwen-code/qwen-code-core/extension/extensionManager.js';
import type { DiscoveredPlugin } from '@qwen-code/qwen-code-core/extension/sourceRegistry.js';
import { redactUrlCredentials } from '@qwen-code/qwen-code-core/extension/redaction.js';
import { t } from '../../i18n/index.js';
import { getErrorMessage } from '../../utils/errors.js';
import {
  sanitizeTerminalLine,
  sanitizeTerminalText,
  truncateToWidth,
  cpSlice,
  getCachedStringWidth,
} from '../utils/textUtils.js';
import { C } from './theme.js';
import { toOriginalKey } from './key-map.js';
import { isPrintableKeyInput } from './input-prompt-key.js';
import { normalizePastedText } from './input-prompt-model.js';
import { caretSpans, endOfLine, useLineEdit } from './line-edit.js';
import { chromeRows, regionListWindow } from './dialogs-core.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';
import {
  DialogSelect,
  useDialogSelect,
  useFocusedKeyboard,
  dialogContentWidth,
  type DialogListItem,
} from './dialogs-shared.js';
import type { ExtensionsStatusMessage } from './dialogs-extensions.js';

export interface OpenTuiExtensionDiscoverTabProps {
  manager: ExtensionManager;
  cwd: string;
  availableTerminalHeight: number | undefined;
  isActive: boolean;
  isCurrent: () => boolean;
  reloadSignal: number;
  marketplaceFilter: string | null;
  onLockChange: (locked: boolean) => void;
  onStatus: (status: ExtensionsStatusMessage | null) => void;
  onInstalled: () => void;
  onFooter: (footer: string | null) => void;
  install: (
    source: string,
    scope: 'user' | 'project',
  ) => Promise<ExtensionsStatusMessage>;
}

type View = 'list' | 'detail' | 'scope-select';
type Action = 'user' | 'project' | 'homepage' | 'back';
type ActionItem = DialogListItem<Action> & { label: string };
const keyOf = (plugin: DiscoveredPlugin) =>
  JSON.stringify([plugin.marketplaceName, plugin.name]);
const safe = (value: string) =>
  sanitizeTerminalLine(redactUrlCredentials(value));
function formatInstalls(count?: number): string | null {
  if (typeof count !== 'number' || !Number.isFinite(count)) return null;
  if (count >= 1_000_000)
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (count >= 1_000)
    return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(count);
}

export function OpenTuiExtensionDiscoverTab(
  props: OpenTuiExtensionDiscoverTabProps,
) {
  const { onLockChange, onFooter } = props;
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(true);
  const owner = useRef({
    manager: props.manager,
    cwd: props.cwd,
    isCurrent: props.isCurrent,
  });
  if (
    owner.current.manager !== props.manager ||
    owner.current.cwd !== props.cwd ||
    owner.current.isCurrent !== props.isCurrent
  ) {
    owner.current = {
      manager: props.manager,
      cwd: props.cwd,
      isCurrent: props.isCurrent,
    };
  }
  const alive = useCallback(
    (captured: typeof owner.current) =>
      mounted.current && captured === owner.current && captured.isCurrent(),
    [],
  );
  const bodyScroll = useRef<ScrollBoxRenderable>(null);
  const fetchSequence = useRef(0);
  const fetching = useRef(false);
  const mutating = useRef(false);
  const [plugins, setPlugins] = useState<DiscoveredPlugin[]>([]);
  const [query, setQuery] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const checkedRef = useRef(checked);
  checkedRef.current = checked;
  const [cursor, setCursor] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const [view, setView] = useState<View>('list');
  const viewRef = useRef(view);
  viewRef.current = view;
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [scopeTargets, setScopeTargets] = useState<DiscoveredPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const line = useLineEdit(query, setQuery);
  const { width, height } = useTerminalDimensions();
  const contentWidth = Math.max(1, dialogContentWidth(width));
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter(
      (plugin) =>
        (!props.marketplaceFilter ||
          plugin.marketplaceName === props.marketplaceFilter) &&
        (!q ||
          plugin.name.toLowerCase().includes(q) ||
          plugin.marketplaceName.toLowerCase().includes(q) ||
          plugin.description?.toLowerCase().includes(q)),
    );
  }, [plugins, query, props.marketplaceFilter]);
  const detail = plugins.find((plugin) => keyOf(plugin) === detailKey);
  const currentList = useRef(filtered);
  currentList.current = filtered;
  const changeView = useCallback((next: View) => {
    viewRef.current = next;
    setView(next);
    latest.current.onLockChange(
      next !== 'list' || mutating.current || openingRef.current,
    );
  }, []);
  const move = useCallback((index: number) => {
    cursorRef.current = index;
    setCursor(index);
  }, []);

  const load = useCallback(
    async (refresh = false, reportFailure = true) => {
      const captured = owner.current;
      const sequence = ++fetchSequence.current;
      fetching.current = true;
      if (!alive(captured)) return;
      setLoading(true);
      try {
        const result = await captured.manager.discoverPlugins({
          refresh,
          cwd: captured.cwd,
        });
        if (!alive(captured) || sequence !== fetchSequence.current) return;
        setPlugins(result);
        if (refresh)
          latest.current.onStatus({
            type: 'success',
            text: t('Refreshed {{count}} extension(s).', {
              count: String(result.length),
            }),
          });
      } catch (error) {
        if (alive(captured) && sequence === fetchSequence.current) {
          const message = safe(getErrorMessage(error));
          if (reportFailure)
            latest.current.onStatus({ type: 'error', text: message });
          return message;
        }
      } finally {
        if (alive(captured) && sequence === fetchSequence.current) {
          fetching.current = false;
          setLoading(false);
        }
      }
      return undefined;
    },
    [alive],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate pending work across effect remounts; this ref is a counter, not a DOM node.
      fetchSequence.current++;
    };
  }, []);
  const loadedOwner = useRef(owner.current);
  useEffect(() => {
    if (loadedOwner.current !== owner.current) {
      loadedOwner.current = owner.current;
      mutating.current = false;
      openingRef.current = false;
      setInstalling(false);
      setOpening(false);
      setPlugins([]);
      setDetailKey(null);
      setScopeTargets([]);
      checkedRef.current = new Set();
      setChecked(checkedRef.current);
      move(0);
      setScrollOffset(0);
      changeView('list');
    }
    // Install owns its own final refresh; a permission body may temporarily hide this tab.
    if (!mutating.current) void load();
  }, [
    props.manager,
    props.cwd,
    props.isCurrent,
    props.reloadSignal,
    load,
    move,
    changeView,
  ]);
  useEffect(() => {
    move(0);
    setScrollOffset(0);
  }, [props.marketplaceFilter, move]);
  useEffect(() => {
    if (cursorRef.current >= filtered.length)
      move(Math.max(0, filtered.length - 1));
  }, [filtered.length, move]);
  useEffect(() => {
    if (view === 'detail' && !detail && !loading) changeView('list');
  }, [view, detail, loading, changeView]);
  useEffect(() => {
    onLockChange(view !== 'list' || installing || opening);
    return () => onLockChange(false);
  }, [view, installing, opening, onLockChange]);
  const footer = installing
    ? t('Installing...')
    : view === 'list'
      ? t(
          'Type to search · Space to toggle · Enter to view · Ctrl+R refresh · Esc to go back',
        )
      : t('↑↓ navigate · Enter select · Esc to go back');
  useEffect(() => {
    onFooter(footer);
    return () => onFooter(null);
  }, [footer, onFooter]);

  const beginBatch = () => {
    const targets = plugins.filter(
      (plugin) => checkedRef.current.has(keyOf(plugin)) && !plugin.installed,
    );
    const single = currentList.current[cursorRef.current];
    if (targets.length === 0 && single && !single.installed)
      targets.push(single);
    if (targets.length === 0) {
      latest.current.onStatus({
        type: 'info',
        text: t('No installable extensions selected.'),
      });
      return;
    }
    setScopeTargets(targets);
    changeView('scope-select');
  };

  const runInstall = async (
    targets: DiscoveredPlugin[],
    scope: 'user' | 'project',
    origin: 'list' | 'detail',
  ) => {
    const captured = owner.current;
    if (!alive(captured) || mutating.current || targets.length === 0) return;
    mutating.current = true;
    fetchSequence.current++;
    fetching.current = false;
    setLoading(false);
    setInstalling(true);
    latest.current.onLockChange(true);
    const install = latest.current.install;
    let installed = 0;
    const errors: string[] = [];
    const warnings: string[] = [];
    const committed = new Set<string>();
    try {
      for (const plugin of targets) {
        if (!alive(captured)) return;
        try {
          const status = await install(plugin.installSource, scope);
          if (!alive(captured)) return;
          if (status.type === 'success' || status.type === 'warning') {
            installed++;
            committed.add(keyOf(plugin));
            if (status.type === 'warning')
              warnings.push(`${safe(plugin.name)}: ${safe(status.text)}`);
          } else {
            errors.push(`${safe(plugin.name)}: ${safe(status.text)}`);
          }
        } catch (error) {
          if (!alive(captured)) return;
          errors.push(`${safe(plugin.name)}: ${safe(getErrorMessage(error))}`);
        }
      }
      if (!alive(captured)) return;
      setPlugins((previous) =>
        previous.map((plugin) =>
          committed.has(keyOf(plugin))
            ? { ...plugin, installed: true }
            : plugin,
        ),
      );
      checkedRef.current = new Set();
      setChecked(checkedRef.current);
      const status: ExtensionsStatusMessage = errors.length
        ? {
            type: 'error',
            text: t('Installed {{ok}}, failed {{fail}}: {{detail}}', {
              ok: String(installed),
              fail: String(errors.length),
              detail: [...warnings, ...errors].join('; '),
            }),
          }
        : warnings.length
          ? {
              type: 'warning',
              text: t(
                'Installed {{count}} extension(s) with warnings: {{detail}}',
                { count: String(installed), detail: warnings.join('; ') },
              ),
            }
          : {
              type: 'success',
              text: t('Installed {{count}} extension(s).', {
                count: String(installed),
              }),
            };
      const reloadError = await load(false, false);
      if (!alive(captured)) return;
      latest.current.onStatus(
        reloadError
          ? {
              type: errors.length ? 'error' : 'warning',
              text: `${status.text} ${reloadError}`,
            }
          : status,
      );
      latest.current.onInstalled();
      changeView(errors.length && origin === 'detail' ? 'detail' : 'list');
    } finally {
      // A stale owner cannot unlock or repaint its successor.
      if (alive(captured)) {
        mutating.current = false;
        setInstalling(false);
      }
    }
  };

  const openHomepage = async () => {
    const captured = owner.current;
    if (!detail?.homepage || !alive(captured) || openingRef.current) return;
    const homepage = detail.homepage;
    let protocol = '';
    try {
      protocol = new URL(homepage).protocol;
    } catch {
      /* Invalid URLs never reach an OS handler. */
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      latest.current.onStatus({
        type: 'error',
        text: t('Failed to open {{url}}', { url: safe(homepage) }),
      });
      return;
    }
    if (process.env['NODE_ENV'] === 'test') {
      latest.current.onStatus({
        type: 'info',
        text: t('Would open: {{url}}', { url: safe(homepage) }),
      });
      return;
    }
    openingRef.current = true;
    setOpening(true);
    try {
      await open(homepage);
    } catch {
      if (alive(captured))
        latest.current.onStatus({
          type: 'error',
          text: t('Failed to open {{url}}', { url: safe(homepage) }),
        });
    } finally {
      if (alive(captured)) {
        openingRef.current = false;
        setOpening(false);
      }
    }
  };

  const actions: ActionItem[] = useMemo(() => {
    const action = (value: Action, label: string): ActionItem => ({
      key: value,
      value,
      label,
    });
    if (view === 'scope-select')
      return [
        action('user', t('Global (User Scope)')),
        action('project', t('Project (Workspace)')),
      ];
    return [
      ...(detail && !detail.installed
        ? [
            action('user', t('Install for you (user scope)')),
            action(
              'project',
              t('Install for the current workspace (project scope)'),
            ),
          ]
        : []),
      ...(detail?.homepage ? [action('homepage', t('Open homepage'))] : []),
      action('back', t('Back to extension list')),
    ];
  }, [view, detail]);
  const heading =
    t('Discover extensions') +
    ` (${filtered.length ? cursor + 1 : 0}/${filtered.length})` +
    (props.marketplaceFilter
      ? t(' · {{marketplace}} (Tab to clear)', {
          marketplace: safe(props.marketplaceFilter),
        })
      : '');
  const regionHeight = clampDialogHeight(
    props.availableTerminalHeight ?? height,
  );
  // Parent subtracts its actual status margin/wrapped text before passing this region.
  const listChrome = {
    fixed: 8,
    runs: [
      { text: footer, width: contentWidth },
      { text: heading, width: contentWidth },
    ],
  };
  const listRows = regionListWindow(
    regionHeight,
    listChrome,
    filtered.length * 3,
    18,
  );
  const maxListItems = Math.floor(listRows.maxItemsToShow / 3);
  const componentLines = [
    { label: t('Skills'), names: detail?.components?.skills },
    { label: t('Commands'), names: detail?.components?.commands },
    { label: t('Agents'), names: detail?.components?.agents },
    { label: t('MCP servers'), names: detail?.components?.mcpServers },
  ].filter((item) => item.names?.length);
  const warning = t(
    '⚠ Make sure you trust an extension before installing, updating, or using it. We cannot verify what MCP servers, files, or other software an extension includes, or that it works as intended. See the extension homepage for more information.',
  );
  const detailGroups = detail
    ? [
        [t('Extension details')],
        [
          safe(detail.name),
          t('from {{marketplace}}', {
            marketplace: safe(detail.marketplaceName),
          }),
          ...(detail.lastUpdated
            ? [t('Last updated: {{date}}', { date: safe(detail.lastUpdated) })]
            : detail.version
              ? [t('Version: {{v}}', { v: safe(detail.version) })]
              : []),
        ],
        ...(detail.description
          ? [[sanitizeTerminalText(redactUrlCredentials(detail.description))]]
          : []),
        ...(detail.author
          ? [[t('By: {{a}}', { a: safe(detail.author) })]]
          : []),
        ...(componentLines.length
          ? [
              [
                t('Will install:'),
                ...componentLines.map(
                  (item) =>
                    `· ${item.label}: ${item.names!.map(safe).join(', ')}`,
                ),
              ],
            ]
          : []),
        [warning],
      ]
    : [];
  const scopeHeading = t('Install {{count}} extension(s) to which scope?', {
    count: String(scopeTargets.length),
  });
  const detailBodyRows = Math.min(
    chromeRows({
      fixed: Math.max(0, detailGroups.length - 1),
      runs: detailGroups.flat().map((text) => ({ text, width: contentWidth })),
    }),
    Math.max(
      0,
      (regionHeight ?? height) -
        chromeRows({
          fixed: 6 + actions.length,
          runs: [{ text: footer, width: contentWidth }],
        }),
    ),
  );
  const actionWindow = regionListWindow(
    regionHeight,
    {
      fixed: 6 + (view === 'detail' ? detailBodyRows : 0),
      runs: [
        { text: footer, width: contentWidth },
        ...(view === 'detail'
          ? []
          : [{ text: scopeHeading, width: contentWidth }]),
      ],
    },
    actions.length,
    actions.length,
  );
  useEffect(() => {
    setScrollOffset((previous) => {
      const top = Math.min(
        previous,
        Math.max(0, filtered.length - maxListItems),
      );
      return cursor < top
        ? cursor
        : maxListItems > 0 && cursor >= top + maxListItems
          ? cursor - maxListItems + 1
          : top;
    });
  }, [cursor, filtered.length, maxListItems]);
  const actionSelect = useDialogSelect({
    items: actions,
    focused:
      props.isActive &&
      view !== 'list' &&
      !installing &&
      !opening &&
      props.isCurrent(),
    numbers: false,
    resyncKey: `${view}:${detailKey}`,
    maxItemsToShow: actionWindow.maxItemsToShow,
    onSelect: (action) => {
      if (
        !latest.current.isActive ||
        !alive(owner.current) ||
        mutating.current ||
        openingRef.current ||
        viewRef.current !== view ||
        view === 'list' ||
        (view === 'detail' && detailBodyRows < 2)
      )
        return;
      if (action === 'back') changeView('list');
      else if (action === 'homepage') void openHomepage();
      else
        void runInstall(
          viewRef.current === 'scope-select'
            ? scopeTargets
            : detail
              ? [detail]
              : [],
          action,
          viewRef.current === 'scope-select' ? 'list' : 'detail',
        );
    },
  });

  useFocusedKeyboard(props.isActive, (event) => {
    if (
      !latest.current.isActive ||
      !alive(owner.current) ||
      event.eventType === 'release' ||
      mutating.current ||
      openingRef.current
    )
      return;
    const key = toOriginalKey(event);
    if (viewRef.current !== 'list') {
      if (viewRef.current === 'detail' && bodyScroll.current) {
        if (key.name === 'pageup') bodyScroll.current.scrollBy(-detailBodyRows);
        if (key.name === 'pagedown')
          bodyScroll.current.scrollBy(detailBodyRows);
      }
      if (key.name === 'escape') changeView('list');
      return;
    }
    if (loading) return;
    if (key.name === 'left' || key.name === 'right' || key.name === 'tab')
      return;
    if (key.ctrl && key.name === 'r') {
      if (!fetching.current) void load(true);
      return;
    }
    const rows = currentList.current;
    if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
      if (maxListItems && rows.length)
        move((cursorRef.current + rows.length - 1) % rows.length);
    } else if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
      if (maxListItems && rows.length)
        move((cursorRef.current + 1) % rows.length);
    } else if (key.name === 'return') {
      if (!maxListItems) return;
      const plugin = rows[cursorRef.current];
      if (checkedRef.current.size) beginBatch();
      else if (plugin) {
        setDetailKey(keyOf(plugin));
        latest.current.onStatus(null);
        changeView('detail');
      }
    } else if (key.name === 'space' || key.sequence === ' ') {
      if (!maxListItems) return;
      const plugin = rows[cursorRef.current];
      if (!plugin || plugin.installed) return;
      const next = new Set(checkedRef.current);
      const identity = keyOf(plugin);
      if (next.has(identity)) next.delete(identity);
      else next.add(identity);
      checkedRef.current = next;
      setChecked(next);
    } else if (!line.handleKey(key) && isPrintableKeyInput(event)) {
      line.insert(event.sequence);
    }
  });
  usePaste((event) => {
    if (
      !latest.current.isActive ||
      !alive(owner.current) ||
      viewRef.current !== 'list' ||
      fetching.current ||
      mutating.current ||
      openingRef.current
    )
      return;
    const text = normalizePastedText(decodePasteBytes(event.bytes));
    if (text) {
      event.preventDefault();
      line.insert(text);
    }
  });

  const listItems = useMemo(
    () => filtered.map((plugin) => ({ key: keyOf(plugin), value: plugin })),
    [filtered],
  );
  const spans = caretSpans({ ...endOfLine(query), cursor: line.caret });
  const queryWidth = Math.max(0, contentWidth - 6);
  let beforeCaret = sanitizeTerminalLine(spans.before);
  const caret = sanitizeTerminalLine(spans.at) || ' ';
  while (beforeCaret && getCachedStringWidth(beforeCaret + caret) > queryWidth)
    beforeCaret = cpSlice(beforeCaret, 1);
  const afterCaret = truncateToWidth(
    sanitizeTerminalLine(spans.after),
    Math.max(0, queryWidth - getCachedStringWidth(beforeCaret + caret)),
  );
  const actionList = (
    <DialogSelect
      items={actions}
      activeIndex={actionSelect.activeIndex}
      scrollOffset={actionSelect.scrollOffset}
      maxItemsToShow={actionWindow.maxItemsToShow}
      showScrollArrows={actionWindow.showScrollArrows}
      showNumbers={false}
      focused={props.isActive && !installing && !opening}
      renderLabel={(item) => (
        <text fg={C.text}>
          {truncateToWidth(item.label, Math.max(1, contentWidth - 2))}
        </text>
      )}
      onHover={actionSelect.highlightIndex}
      onSelectIndex={actionSelect.selectIndex}
    />
  );

  if (loading) return <text fg={C.dim}>{t('Discovering extensions...')}</text>;
  if (view === 'scope-select')
    return (
      <box flexDirection="column" gap={1}>
        <text fg={C.text}>{scopeHeading}</text>
        {installing ? <text fg={C.dim}>{t('Installing...')}</text> : actionList}
      </box>
    );
  if (view === 'detail' && detail)
    return (
      <box flexDirection="column" gap={1}>
        <scrollbox
          ref={bodyScroll}
          key={detailKey ?? undefined}
          height={detailBodyRows}
          flexShrink={1}
          stickyScroll={false}
        >
          <box flexDirection="column" gap={1}>
            {detailGroups.map((group, index) => (
              <box key={index} flexDirection="column">
                {group.map((text, lineIndex) => (
                  <text key={lineIndex} fg={C.text}>
                    {text}
                  </text>
                ))}
              </box>
            ))}
          </box>
        </scrollbox>
        {installing ? <text fg={C.dim}>{t('Installing...')}</text> : actionList}
      </box>
    );
  if (!plugins.length)
    return (
      <box flexDirection="column">
        <text fg={C.dim}>{t('No extensions discovered.')}</text>
        <text fg={C.dim}>
          {t('Add a marketplace in the Sources tab to discover extensions.')}
        </text>
      </box>
    );
  return (
    <box flexDirection="column">
      <text fg={C.text}>{heading}</text>
      <box
        flexDirection="row"
        borderStyle="rounded"
        borderColor={C.dim}
        paddingX={1}
        width={contentWidth}
      >
        <text fg={C.dim}>{'⌕ '}</text>
        {queryWidth > 0 ? (
          <>
            {beforeCaret ? <text fg={C.text}>{beforeCaret}</text> : null}
            <text bg={C.accent}>{caret}</text>
            {afterCaret ? <text fg={C.text}>{afterCaret}</text> : null}
          </>
        ) : null}
      </box>
      {!filtered.length ? (
        <text fg={C.dim}>{t('No extensions match your search.')}</text>
      ) : (
        <DialogSelect
          items={listItems}
          activeIndex={cursor}
          scrollOffset={scrollOffset}
          maxItemsToShow={maxListItems}
          showScrollArrows={listRows.showScrollArrows}
          showNumbers={false}
          focused={props.isActive}
          renderLabel={(item) => {
            const plugin = item.value;
            const count = formatInstalls(plugin.installs);
            return (
              <box flexDirection="column" marginBottom={1}>
                <text fg={plugin.installed ? C.green : C.text}>
                  {truncateToWidth(
                    `${plugin.installed ? '✓' : checked.has(keyOf(plugin)) ? '●' : '○'} ${safe(plugin.name)} · ${safe(plugin.marketplaceName)}${count ? ` · ${count} installs` : ''}${plugin.installed ? ` · ${t('installed')}` : ''}`,
                    Math.max(1, contentWidth - 2),
                  )}
                </text>
                <text fg={C.dim}>
                  {truncateToWidth(
                    safe(plugin.description ?? ''),
                    Math.max(1, contentWidth - 4),
                  )}
                </text>
              </box>
            );
          }}
        />
      )}
    </box>
  );
}
