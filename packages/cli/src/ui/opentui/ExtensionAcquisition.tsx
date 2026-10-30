/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { decodePasteBytes, type ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, usePaste } from '@opentui/react';
import type { ExtensionManager } from '@qwen-code/qwen-code-core/extension/extensionManager.js';
import { isExtensionCommittedWithWarningsError } from '@qwen-code/qwen-code-core/extension/extensionManager.js';
import type { ExtensionSetting } from '@qwen-code/qwen-code-core/extension/extensionSettings.js';
import type { ClaudeMarketplaceConfig } from '@qwen-code/qwen-code-core/extension/claude-converter.js';
import { redactUrlCredentials } from '@qwen-code/qwen-code-core/extension/redaction.js';
import { requestConsentOrFail } from '../../commands/extensions/consent.js';
import { t } from '../../i18n/index.js';
import { getErrorMessage } from '../../utils/errors.js';
import {
  sanitizeTerminalLine,
  sanitizeTerminalText,
  truncateToWidth,
} from '../utils/textUtils.js';
import type { ExtensionsStatusMessage } from './dialogs-extensions.js';
import { OpenTuiActionConfirmation } from './dialogs-confirm.js';
import {
  DialogFrame,
  DialogSelect,
  FooterHint,
  useDialogSelect,
} from './dialogs-shared.js';
import {
  applyLineKey,
  windowLineAtCaret,
  endOfLine,
  insertAtCaret,
  type LineState,
} from './line-edit.js';
import { toOriginalKey } from './key-map.js';
import { isPrintableKeyInput } from './input-prompt-key.js';
import { C, SYNTAX } from './theme.js';
import { regionListWindow, wrappedRows } from './dialogs-core.js';

export interface ExtensionCatalogContext {
  manager: ExtensionManager;
  cwd: string;
  isCurrent: () => boolean;
  reload: () => Promise<void>;
  onChanged: () => void;
  onStatus: (status: ExtensionsStatusMessage | null) => void;
}

type Permission =
  | {
      kind: 'consent';
      id: number;
      text: string;
      resolve: (yes: boolean) => void;
    }
  | {
      kind: 'setting';
      id: number;
      setting: ExtensionSetting;
      resolve: (value: string) => void;
      cancel: () => void;
    }
  | {
      kind: 'choice';
      id: number;
      marketplace: ClaudeMarketplaceConfig;
      resolve: (name: string) => void;
      cancel: () => void;
    };

const cancelled = () => new Error(t('Extension installation cancelled.'));

export function useExtensionAcquisition(context?: ExtensionCatalogContext) {
  const latest = useRef(context);
  latest.current = context;
  const mounted = useRef(false);
  const operation = useRef<{
    controller: AbortController;
    current: () => boolean;
  } | null>(null);
  const sequence = useRef(0);
  const [permission, setPermission] = useState<Permission | null>(null);
  const [pending, setPending] = useState(false);
  useLayoutEffect(() => {
    mounted.current = true;
    setPermission(null);
    setPending(false);
    return () => {
      mounted.current = false;
      operation.current?.controller.abort();
      operation.current = null;
    };
  }, [context?.manager, context?.cwd, context?.isCurrent]);

  const install = async (
    source: string,
    scope: 'user' | 'project',
    rememberScope: boolean,
  ): Promise<ExtensionsStatusMessage> => {
    const captured = latest.current;
    if (!captured || !captured.isCurrent() || operation.current)
      throw cancelled();
    const controller = new AbortController();
    const owner = {
      controller,
      current: () =>
        mounted.current &&
        operation.current === owner &&
        !controller.signal.aborted &&
        captured.isCurrent() &&
        latest.current?.isCurrent === captured.isCurrent,
    };
    operation.current = owner;
    setPending(true);
    const check = () => {
      if (!owner.current()) throw cancelled();
    };
    const ask = <T,>(
      create: (
        id: number,
        resolve: (value: T) => void,
        reject: () => void,
      ) => Permission,
      cancellation = t('Extension installation cancelled.'),
    ): Promise<T> => {
      check();
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (accepted: boolean, value?: T) => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener('abort', abort);
          if (mounted.current)
            setPermission((shown) => (shown === request ? null : shown));
          if (accepted && owner.current()) resolve(value as T);
          else reject(new Error(cancellation));
        };
        const abort = () => finish(false);
        const request = create(
          ++sequence.current,
          (value) => finish(true, value),
          abort,
        );
        controller.signal.addEventListener('abort', abort, { once: true });
        setPermission(request);
      });
    };
    try {
      const metadata = await captured.manager.parseInstallSource(
        source,
        captured.cwd,
      );
      check();
      if (metadata.marketplaceConfig && !metadata.pluginName) {
        const marketplace = metadata.marketplaceConfig;
        if (!marketplace.plugins.length)
          throw new Error(t('No plugins available in this marketplace.'));
        metadata.pluginName = await ask<string>(
          (id, resolve, cancel) => ({
            kind: 'choice',
            id,
            marketplace,
            resolve,
            cancel,
          }),
          t('Plugin selection cancelled.'),
        );
        check();
        if (
          marketplace.plugins.filter(
            (plugin) => plugin.name === metadata.pluginName,
          ).length !== 1
        )
          throw new Error(t('Select a unique plugin from the marketplace.'));
      }
      let name: string;
      const warnings: string[] = [];
      try {
        const extension = await captured.manager.installExtension(
          metadata,
          (options) =>
            requestConsentOrFail(
              (text) =>
                ask<boolean>((id, resolve) => ({
                  kind: 'consent',
                  id,
                  text,
                  resolve,
                })),
              options,
            ),
          (setting) =>
            ask<string>(
              (id, resolve, cancel) => ({
                kind: 'setting',
                id,
                setting,
                resolve,
                cancel,
              }),
              t('Setting input cancelled'),
            ),
          captured.cwd,
          undefined,
          scope === 'user'
            ? { scope: 'user' }
            : { scope: 'workspace', workspacePath: captured.cwd },
          controller.signal,
        );
        name = extension.name;
      } catch (error) {
        if (!isExtensionCommittedWithWarningsError(error)) throw error;
        name = error.identity.name;
        warnings.push(getErrorMessage(error));
      }
      check();
      if (rememberScope) {
        try {
          captured.manager.setExtensionScope(name, scope);
        } catch (error) {
          warnings.push(getErrorMessage(error));
        }
      }
      try {
        await captured.reload();
      } catch (error) {
        warnings.push(getErrorMessage(error));
      }
      check();
      return {
        type: warnings.length ? 'warning' : 'success',
        text: warnings.length
          ? `${t('Installed extension "{{name}}".', { name })} ${warnings.map((warning) => redactUrlCredentials(warning)).join('; ')}`
          : t('Installed extension "{{name}}".', { name }),
      };
    } finally {
      if (operation.current === owner) {
        operation.current = null;
        controller.abort();
        if (mounted.current) {
          setPending(false);
          setPermission(null);
        }
      }
    }
  };
  return { install, permission, pending };
}

function PermissionText({
  text,
  width,
  rows,
  markdown = false,
}: {
  text: string;
  width: number;
  rows: number;
  markdown?: boolean;
}) {
  const scroll = useRef<ScrollBoxRenderable>(null);
  const count = Math.max(0, Math.min(rows, wrappedRows(text, width)));
  useKeyboard((event) => {
    if (event.eventType === 'release') return;
    const key = toOriginalKey(event);
    if (key.name === 'pageup') scroll.current?.scrollBy(-count);
    if (key.name === 'pagedown') scroll.current?.scrollBy(count);
  });
  return (
    <scrollbox ref={scroll} height={count} stickyScroll={false}>
      {markdown ? (
        <markdown
          content={sanitizeTerminalText(text)}
          syntaxStyle={SYNTAX}
          streaming={false}
        />
      ) : (
        <text fg={C.text}>{sanitizeTerminalText(text)}</text>
      )}
    </scrollbox>
  );
}

function ExtensionSettingInput({
  permission,
  width,
  height,
}: {
  permission: Extract<Permission, { kind: 'setting' }>;
  width: number;
  height: number;
}) {
  const state = useRef<LineState>(endOfLine(''));
  const [, repaint] = useState(0);
  const settled = useRef(false);
  const update = (next: LineState) => {
    state.current = next;
    repaint((n) => n + 1);
  };
  const insert = (text: string) =>
    update(
      insertAtCaret(
        state.current,
        permission.setting.sensitive
          ? [...text].filter((char) => char >= ' ' && char <= '~').join('')
          : text,
      ),
    );
  useKeyboard((event) => {
    if (settled.current || event.eventType === 'release') return;
    const key = toOriginalKey(event);
    if (key.name === 'escape') {
      settled.current = true;
      permission.cancel();
    } else if (key.name === 'return') {
      if (height >= 10 && width >= 8 && state.current.text.trim()) {
        settled.current = true;
        permission.resolve(state.current.text);
      }
    } else if (key.ctrl && key.name === 'u') update(endOfLine(''));
    else {
      const next = applyLineKey(state.current, key);
      if (next) update(next);
      else if (isPrintableKeyInput(event)) insert(event.sequence);
    }
  });
  usePaste((event) => {
    if (settled.current) return;
    event.preventDefault();
    insert(decodePasteBytes(event.bytes));
  });
  const visible = permission.setting.sensitive
    ? {
        text: '*'.repeat([...state.current.text].length),
        cursor: state.current.cursor,
      }
    : state.current;
  const spans = windowLineAtCaret(visible, Math.max(0, width - 3));
  return (
    <DialogFrame>
      <text fg={C.accent}>
        {truncateToWidth(sanitizeTerminalLine(permission.setting.name), width)}
      </text>
      <PermissionText
        text={permission.setting.description}
        width={width}
        rows={
          height -
          8 -
          Math.max(
            0,
            wrappedRows(t('Press Enter to submit, Escape to cancel'), width) -
              1,
          )
        }
      />
      <box flexDirection="row">
        <text fg={C.accent}>{'> '}</text>
        <text fg={C.text}>{sanitizeTerminalText(spans.before)}</text>
        <text bg={C.accent}>{sanitizeTerminalText(spans.at) || ' '}</text>
        <text fg={C.text}>{sanitizeTerminalText(spans.after)}</text>
      </box>
      <FooterHint text={t('Press Enter to submit, Escape to cancel')} />
    </DialogFrame>
  );
}

function ExtensionPluginChoice({
  permission,
  width,
  height,
}: {
  permission: Extract<Permission, { kind: 'choice' }>;
  width: number;
  height: number;
}) {
  const items = permission.marketplace.plugins.map((plugin) => ({
    key: plugin.name,
    value: plugin.name,
    label: plugin.name,
    description: plugin.description,
  }));
  const settled = useRef(false);
  const footer = t(
    'Use ↑↓ or j/k to navigate, Enter to select, Escape to cancel',
  );
  const window = regionListWindow(
    height,
    { fixed: 10, runs: [{ text: footer, width }] },
    items.length,
    10,
  );
  const select = useDialogSelect({
    items,
    numbers: false,
    maxItemsToShow: window.maxItemsToShow,
    onSelect: (name) => {
      if (window.maxItemsToShow > 0 && !settled.current) {
        settled.current = true;
        permission.resolve(name);
      }
    },
  });
  useKeyboard((event) => {
    if (settled.current || event.eventType === 'release') return;
    const key = toOriginalKey(event);
    if (key.name === 'escape') {
      settled.current = true;
      permission.cancel();
    } else if (window.maxItemsToShow > 0 && /^[1-9]$/.test(key.sequence)) {
      select.selectIndex(Number(key.sequence) - 1);
    }
  });
  return (
    <DialogFrame>
      <text fg={C.accent}>
        {t('Select a plugin from "{{name}}"', {
          name: truncateToWidth(
            sanitizeTerminalLine(permission.marketplace.name),
            Math.max(1, width - 24),
          ),
        })}
      </text>
      <DialogSelect
        items={items}
        activeIndex={select.activeIndex}
        scrollOffset={select.scrollOffset}
        maxItemsToShow={window.maxItemsToShow}
        showScrollArrows={window.showScrollArrows}
        showNumbers={false}
        onHover={select.highlightIndex}
        onSelectIndex={select.selectIndex}
        renderLabel={(item) => (
          <text fg={C.text}>
            {truncateToWidth(
              sanitizeTerminalLine(item.label),
              Math.max(1, width - 2),
            )}
          </text>
        )}
      />
      {items[select.activeIndex]?.description ? (
        <PermissionText
          text={items[select.activeIndex].description!}
          width={width}
          rows={3}
        />
      ) : null}
      <FooterHint text={footer} />
    </DialogFrame>
  );
}

export function OpenTuiExtensionPermission({
  permission,
  width,
  availableTerminalHeight: height,
}: {
  permission: Permission;
  width: number;
  availableTerminalHeight: number;
}) {
  if (permission.kind === 'setting')
    return (
      <ExtensionSettingInput
        key={permission.id}
        permission={permission}
        width={width}
        height={height}
      />
    );
  if (permission.kind === 'choice')
    return (
      <ExtensionPluginChoice
        key={permission.id}
        permission={permission}
        width={width}
        height={height}
      />
    );
  return (
    <OpenTuiActionConfirmation
      key={permission.id}
      prompt={
        <PermissionText
          markdown
          text={permission.text + '\n\n' + t('Do you want to continue?')}
          width={width}
          rows={
            height -
            8 -
            wrappedRows(
              t('↑↓ to choose · Enter to confirm · Esc to cancel'),
              width,
            )
          }
        />
      }
      onResolve={(yes) => {
        if (!yes || (height >= 12 && width >= 8)) permission.resolve(yes);
      }}
    />
  );
}
