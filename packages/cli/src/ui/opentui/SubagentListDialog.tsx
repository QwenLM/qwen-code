/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from '@opentui/react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  getExternalEditorCommand,
  isValidEditorType,
} from '@qwen-code/qwen-code-core/utils/editor.js';
import { Kind } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { SubagentConfig } from '@qwen-code/qwen-code-core/subagents/types.js';
import type { LoadedSettings } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import { COLOR_OPTIONS } from '../components/subagents/constants.js';
import {
  getColorForDisplay,
  shouldShowColor,
} from '../components/subagents/utils.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';
import {
  sanitizeTerminalLine,
  sanitizeTerminalText,
  truncateToWidth,
} from '../utils/textUtils.js';
import { useBatchSafeState } from './batch-cursor.js';
import { scrollDialogLayout, wrappedRows } from './dialogs-core.js';
import {
  DialogFrame,
  DialogSelect,
  dialogContentWidth,
  useDialogSelect,
} from './dialogs-shared.js';
import { toOriginalKey } from './key-map.js';
import { C } from './theme.js';

type Page =
  | 'list'
  | 'actions'
  | 'detail'
  | 'edit'
  | 'tools'
  | 'color'
  | 'delete';

export function OpenTuiSubagentListDialog({
  config,
  settings,
  onClose,
  availableTerminalHeight,
}: {
  config?: Config;
  settings?: LoadedSettings;
  onClose: () => void;
  availableTerminalHeight?: number;
}) {
  const page = useBatchSafeState<Page>('list');
  const setPage = page.setValue;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [data, setData] = useState<{
    owner: Config | undefined;
    agents: SubagentConfig[];
    loading: boolean;
    error: string;
  }>({ owner: config, agents: [], loading: true, error: '' });
  const alive = useRef(true);
  const owner = useRef(config);
  owner.current = config;
  const scroll = useRef<ScrollBoxRenderable>(null);
  const renderer = useRenderer();
  const operation = useRef<object | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = (next: Page) => {
    setError('');
    setPage(next);
  };
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    operation.current = null;
    setBusy(false);
    setError('');
    setPage('list');
    setSelectedIndex(0);
    setData({ owner: config, agents: [], loading: true, error: '' });
    const load = async () => {
      try {
        if (!config) throw new Error(t('Configuration not available'));
        const agents = await config
          .getSubagentManager()
          .listSubagents({ force: true });
        if (current && alive.current)
          setData({ owner: config, agents, loading: false, error: '' });
      } catch (error) {
        if (current && alive.current)
          setData({
            owner: config,
            agents: [],
            loading: false,
            error:
              (error instanceof Error ? error.message : String(error)) ||
              t('Error'),
          });
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [config, setPage]);

  const ready = data.owner === config && !data.loading && !data.error;
  const selected = ready ? data.agents[selectedIndex] : undefined;
  const writable = Boolean(
    selected &&
      !selected.isBuiltin &&
      selected.filePath &&
      (selected.level === 'project' || selected.level === 'user'),
  );
  const categories = useMemo(() => {
    if (page.value !== 'tools' || !config || !ready) return [];
    const tools = config.getToolRegistry().getAllTools();
    const names = (kinds: Kind[]) =>
      tools
        .filter((tool) => kinds.includes(tool.kind))
        .map((tool) => tool.displayName)
        .sort();
    const read = names([Kind.Read, Kind.Search, Kind.Fetch, Kind.Think]);
    const edit = names([Kind.Edit, Kind.Delete, Kind.Move]);
    const execute = names([Kind.Execute]);
    return [
      { id: 'all', label: t('All Tools'), tools: [] as string[] },
      { id: 'read', label: t('Read-only Tools'), tools: read },
      { id: 'edit', label: t('Read & Edit Tools'), tools: [...read, ...edit] },
      {
        id: 'execute',
        label: t('Read & Edit & Execution Tools'),
        tools: [...read, ...edit, ...execute],
      },
    ].filter((category) => category.id === 'all' || category.tools.length > 0);
  }, [config, page.value, ready]);
  const commit = async (
    updates?: Pick<SubagentConfig, 'tools'> | Pick<SubagentConfig, 'color'>,
  ) => {
    if (!config || !selected || !writable || operation.current) return;
    const token = {};
    operation.current = token;
    setBusy(true);
    setError('');
    const assertCanCommit = () => {
      if (
        !alive.current ||
        owner.current !== config ||
        operation.current !== token ||
        page.ref.current !== page.value
      )
        throw new Error('Agent action is no longer active');
    };
    let committed = false;
    try {
      const manager = config.getSubagentManager();
      if (updates)
        await manager.updateSubagent(selected.name, updates, selected.level, {
          assertCanCommit,
        });
      else
        await manager.deleteSubagent(
          selected.name,
          selected.level,
          selected.extensionName,
          { assertCanCommit },
        );
      committed = true;
      assertCanCommit();
      const agents = await manager.listSubagents({ force: true });
      assertCanCommit();
      setData({ owner: config, agents, loading: false, error: '' });
      const index = agents.findIndex(
        (agent) =>
          agent.name === selected.name && agent.level === selected.level,
      );
      setSelectedIndex(Math.max(0, index));
      navigate(updates && index >= 0 ? 'edit' : 'list');
    } catch (error) {
      if (
        alive.current &&
        owner.current === config &&
        operation.current === token
      )
        setError(
          (committed ? 'Changes committed; refresh failed: ' : '') +
            (error instanceof Error ? error.message : String(error)),
        );
    } finally {
      if (operation.current === token) {
        operation.current = null;
        if (alive.current && owner.current === config) setBusy(false);
      }
    }
  };
  const openEditor = async () => {
    const filePath = selected?.filePath;
    if (
      !filePath ||
      !writable ||
      operation.current ||
      !alive.current ||
      owner.current !== config
    )
      return;
    const token = {};
    operation.current = token;
    setBusy(true);
    setError('');
    let suspended = false;
    try {
      // Keep the token through the rest of this synchronous key burst.
      await Promise.resolve();
      if (
        !alive.current ||
        owner.current !== config ||
        operation.current !== token ||
        page.ref.current !== 'edit'
      )
        return;
      const preferred = settings?.merged.general?.preferredEditor;
      let command: string;
      let args: string[];
      let shell = false;
      if (preferred) {
        if (!isValidEditorType(preferred))
          throw new Error('Invalid preferred editor');
        const resolved = getExternalEditorCommand(preferred, filePath);
        if (!resolved) throw new Error('Preferred editor is not available');
        ({ command, args } = resolved);
        shell = resolved.needsShell;
      } else if (process.platform === 'darwin') {
        command = 'open';
        args = ['-t', filePath];
      } else {
        command =
          process.env['VISUAL'] ||
          process.env['EDITOR'] ||
          (process.platform === 'win32' ? 'notepad' : 'vi');
        args = [filePath];
        shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
      }
      if (shell) {
        if (/["|%!]/.test(command)) throw new Error('Unsafe editor command');
        if (args.some((arg) => /["%!]/.test(arg)))
          throw new Error('Unsafe editor path or argument');
        command = `"${command}"`;
        args = args.map((arg) => `"${arg}"`);
      }
      suspended = true;
      renderer.suspend();
      const result = spawnSync(command, args, { stdio: 'inherit', shell });
      if (result.error) throw result.error;
      if (result.signal)
        throw new Error(`Editor exited with signal ${result.signal}`);
      if (result.status !== 0)
        throw new Error(`Editor exited with status ${result.status}`);
    } catch (error) {
      if (alive.current && owner.current === config)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (suspended) {
        try {
          renderer.resume();
        } catch (error) {
          if (alive.current && owner.current === config)
            setError((previous) =>
              [previous, String(error)].filter(Boolean).join('\n'),
            );
        }
      }
      if (operation.current === token) {
        operation.current = null;
        if (alive.current && owner.current === config) setBusy(false);
      }
    }
  };
  const title =
    page.value === 'list'
      ? t('Agents')
      : page.value === 'actions'
        ? t('Choose Action')
        : page.value === 'edit'
          ? t('Edit {{name}}', {
              name: sanitizeTerminalLine(selected?.name ?? ''),
            })
          : page.value === 'tools'
            ? t('Edit Tools: {{name}}', {
                name: sanitizeTerminalLine(selected?.name ?? ''),
              })
            : page.value === 'color'
              ? t('Edit Color: {{name}}', {
                  name: sanitizeTerminalLine(selected?.name ?? ''),
                })
              : page.value === 'delete'
                ? t('Delete {{name}}', {
                    name: sanitizeTerminalLine(selected?.name ?? ''),
                  })
                : sanitizeTerminalLine(selected?.name ?? '');
  const { width } = useTerminalDimensions();
  const items = useMemo(() => {
    if (page.value === 'list')
      return data.agents.map((agent, index) => ({
        key: String(index),
        value: String(index),
        label: agent.name,
      }));
    if (page.value === 'actions')
      return [
        { key: 'view', value: 'view', label: t('View Agent') },
        ...(writable
          ? [
              { key: 'edit', value: 'edit', label: t('Edit Agent') },
              { key: 'delete', value: 'delete', label: t('Delete Agent') },
            ]
          : []),
        { key: 'back', value: 'back', label: t('Back') },
      ];
    if (page.value === 'edit')
      return [
        { key: 'editor', value: 'editor', label: t('Open in editor') },
        { key: 'tools', value: 'tools', label: t('Edit tools') },
        { key: 'color', value: 'color', label: t('Edit color') },
      ];
    if (page.value === 'tools')
      return categories.map((category) => ({
        key: category.id,
        value: category.id,
        label: category.label,
      }));
    if (page.value === 'color')
      return COLOR_OPTIONS.map((color) => ({
        key: color.id,
        value: color.id,
        label: color.name,
      }));
    return [];
  }, [page.value, data.agents, writable, categories]);
  const footer =
    page.value === 'detail'
      ? t('Esc to go back')
      : page.value === 'delete'
        ? t('Enter to confirm, Esc to cancel')
        : items.length > 0 && ready
          ? page.value === 'list'
            ? t('Enter to select, ↑↓ to navigate, Esc to close')
            : t('Enter to select, ↑↓ to navigate, Esc to go back')
          : t('Esc to close');
  const confirmation = t('Are you sure you want to delete agent "{{name}}"?', {
    name: sanitizeTerminalLine(selected?.name ?? ''),
  });
  const contentWidth = dialogContentWidth(width);
  const layout = scrollDialogLayout(
    clampDialogHeight(availableTerminalHeight),
    5 + wrappedRows(title, contentWidth) + wrappedRows(footer, contentWidth),
    12,
  );
  const selectedTools = new Set(selected?.tools ?? []);
  const select = useDialogSelect({
    items,
    initialIndex:
      page.value === 'list'
        ? selectedIndex
        : page.value === 'color'
          ? Math.max(
              0,
              COLOR_OPTIONS.findIndex(
                (color) =>
                  color.id === selected?.color ||
                  color.name === selected?.color,
              ),
            )
          : page.value === 'tools'
            ? Math.max(
                0,
                categories.findIndex(
                  (category) =>
                    new Set(category.tools).size === selectedTools.size &&
                    category.tools.every((tool) => selectedTools.has(tool)),
                ),
              )
            : 0,
    resyncKey: page.value,
    numbers: false,
    focused:
      ready && !busy && page.value !== 'detail' && page.value !== 'delete',
    maxItemsToShow: layout.bodyRows,
    onSelect: (value) => {
      if (
        !alive.current ||
        owner.current !== config ||
        !ready ||
        operation.current ||
        page.ref.current !== page.value
      )
        return;
      if (page.value === 'list') {
        setSelectedIndex(Number(value));
        navigate('actions');
      } else if (page.value === 'actions') {
        navigate(
          value === 'view'
            ? 'detail'
            : value === 'edit'
              ? 'edit'
              : value === 'delete'
                ? 'delete'
                : 'list',
        );
      } else if (page.value === 'edit') {
        if (value === 'editor') void openEditor();
        else navigate(value as 'tools' | 'color');
      } else if (page.value === 'tools') {
        const category = categories.find((category) => category.id === value);
        if (category) void commit({ tools: category.tools });
      } else if (page.value === 'color') {
        const color = COLOR_OPTIONS.find((color) => color.id === value);
        if (color) void commit({ color: color.id });
      }
    },
  });
  useKeyboard((key) => {
    if (
      !alive.current ||
      owner.current !== config ||
      key.eventType === 'release' ||
      operation.current ||
      page.ref.current !== page.value
    )
      return;
    const original = toOriginalKey(key);
    const { name } = original;
    if (name === 'escape') {
      if (
        page.value === 'detail' ||
        page.value === 'edit' ||
        page.value === 'delete'
      )
        navigate('actions');
      else if (page.value === 'tools' || page.value === 'color')
        navigate('edit');
      else if (page.value === 'actions') navigate('list');
      else {
        alive.current = false;
        onClose();
      }
      return;
    }
    if (page.value === 'delete' && !original.ctrl && !original.meta) {
      if (
        (name === 'return' || name === 'y') &&
        contentWidth > 0 &&
        wrappedRows(confirmation, contentWidth) <= layout.bodyRows
      )
        void commit();
      else if (name === 'n') navigate('actions');
      return;
    }
    if (page.value !== 'detail' || !scroll.current) return;
    if (name === 'up') scroll.current.scrollBy(-1);
    if (name === 'down') scroll.current.scrollBy(1);
    if (name === 'pageup') scroll.current.scrollBy(-layout.bodyRows);
    if (name === 'pagedown') scroll.current.scrollBy(layout.bodyRows);
    if (name === 'home') scroll.current.scrollTo(0);
    if (name === 'end') scroll.current.scrollTo(scroll.current.scrollHeight);
  });

  return (
    <DialogFrame bodyLayout={layout}>
      {!layout.compact && (
        <text fg={C.text} attributes={1}>
          {title}
        </text>
      )}
      <scrollbox
        key={`${page.value}-${width}-${layout.bodyRows}-${layout.compact}`}
        ref={scroll}
        height={layout.bodyRows}
        marginTop={layout.compact ? 0 : 1}
        flexShrink={1}
        stickyScroll={false}
      >
        {data.owner !== config || data.loading ? (
          <text fg={C.dim}>{t('Loading...')}</text>
        ) : data.error ? (
          <text fg={C.red}>{sanitizeTerminalText(data.error)}</text>
        ) : busy ? (
          <text fg={C.dim}>{t('Loading...')}</text>
        ) : page.value === 'delete' && selected ? (
          <text fg={C.red}>{confirmation}</text>
        ) : page.value === 'detail' && selected ? (
          <box flexDirection="column">
            <text fg={C.text}>
              {t('File Path: ')}
              {sanitizeTerminalText(selected.filePath ?? '')}
            </text>
            <text fg={C.text}>
              {t('Tools: ')}
              {sanitizeTerminalText(
                selected.tools ? selected.tools.join(', ') : '*',
              )}
            </text>
            {selected.model && (
              <text fg={C.text}>
                {t('Model: ')}
                {sanitizeTerminalText(selected.model)}
              </text>
            )}
            {shouldShowColor(selected.color) && (
              <text fg={getColorForDisplay(selected.color) ?? C.text}>
                {t('Color: ')}
                {sanitizeTerminalText(selected.color ?? '')}
              </text>
            )}
            <text fg={C.text} marginTop={1}>
              {t('Description:')}
            </text>
            <text fg={C.text}>
              {sanitizeTerminalText(selected.description)}
            </text>
            <text fg={C.text} marginTop={1}>
              {t('System Prompt:')}
            </text>
            <text fg={C.text}>
              {sanitizeTerminalText(selected.systemPrompt)}
            </text>
          </box>
        ) : items.length === 0 ? (
          <text fg={C.dim}>{t('No subagents found.')}</text>
        ) : (
          <DialogSelect
            {...select}
            maxItemsToShow={layout.bodyRows}
            showNumbers={false}
            showScrollArrows={false}
            onSelectIndex={select.selectIndex}
            onHover={select.highlightIndex}
            renderLabel={(item, { titleColor }) => (
              <text fg={titleColor}>
                {truncateToWidth(
                  sanitizeTerminalLine(item.label),
                  Math.max(0, dialogContentWidth(width) - 2),
                )}
              </text>
            )}
          />
        )}
        {error && <text fg={C.red}>{sanitizeTerminalText(error)}</text>}
        {!busy && page.value === 'tools' && categories[select.activeIndex] && (
          <text fg={C.dim}>
            {sanitizeTerminalLine(
              categories[select.activeIndex].tools.join(', '),
            ) || t('All tools selected, including MCP tools')}
          </text>
        )}
        {!busy &&
          page.value === 'color' &&
          COLOR_OPTIONS[select.activeIndex] && (
            <text
              fg={
                getColorForDisplay(COLOR_OPTIONS[select.activeIndex].id) ??
                C.text
              }
            >
              {t('Preview:')} {sanitizeTerminalLine(selected?.name ?? '')}
            </text>
          )}
      </scrollbox>
      {!layout.compact && <text fg={C.dim}>{footer}</text>}
    </DialogFrame>
  );
}
