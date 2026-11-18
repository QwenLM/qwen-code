/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EditBufferRenderable,
  MarkdownRenderable,
  SelectRenderable,
  TextBufferRenderable,
  TextTableRenderable,
  TextareaRenderable,
  type Renderable,
} from '@opentui/core';
import type { ScreenReaderOutputWriter } from './a11y-screen-reader.js';
import { markdownToPlainText } from './a11y-plain-text.js';
import { cpLen } from '../utils/textUtils.js';
import { getCurrentLanguage, t } from '../../i18n/index.js';

const HISTORY_ROLE_LABELS = new Set([
  'user',
  'assistant',
  'thinking',
  'tool',
  'task',
  'image',
  'compaction',
  'info',
  'error',
  'warning',
  'retry',
  'stop-hook',
  'away-recap',
  'user-shell',
  'advisor',
  'arena-agent',
  'arena-session',
  'goal',
]);

interface ControlRow {
  owner: Renderable;
  text: string;
}

function inputLineText(node: Renderable): string {
  if (!node.visible || node.isDestroyed) return '';
  if (node.id === 'screen-reader-protected-input') return t('Protected input');
  if (node.id === 'screen-reader-input-glyph') return '';
  if (node instanceof TextBufferRenderable) return node.plainText;
  return node.getChildren().map(inputLineText).join('');
}

function inputCaret(node: Renderable): RegExpExecArray | null {
  if (
    !node.visible ||
    node.isDestroyed ||
    node.id === 'screen-reader-protected-input'
  )
    return null;
  const own = /^screen-reader-caret-(active|inactive)-(\d+)$/.exec(
    node.id ?? '',
  );
  if (own) return own;
  for (const child of node.getChildren()) {
    const found = inputCaret(child);
    if (found) return found;
  }
  return null;
}

/** Reads public semantic values, never the painted cell buffer or colors. */
function controlRows(node: Renderable): ControlRow[] {
  if (!node.visible || node.isDestroyed) return [];
  if (node.id === 'screen-reader-history') {
    // Items and the range are published from the model on every change; only
    // the invariant navigation help rides the per-owner dedupe, so it is
    // spoken once instead of once per window change.
    const help = node.findDescendantById('screen-reader-history-help');
    return help ? controlRows(help) : [];
  }
  if (node.id === 'screen-reader-protected-input')
    return [{ owner: node, text: t('Protected input') }];
  if (
    node.id === 'screen-reader-input-line' ||
    node.id === 'screen-reader-input-line-placeholder'
  ) {
    const caret = inputCaret(node);
    const focus = caret
      ? caret[1] === 'active'
        ? `${t('Focused input. Cursor: {{position}}', { position: caret[2] })}\n`
        : `${t('Unfocused input.')}\n`
      : '';
    const value = inputLineText(node);
    return [
      {
        owner: node,
        text:
          focus +
          (node.id === 'screen-reader-input-line-placeholder'
            ? t('Placeholder: {{value}}', { value })
            : value),
      },
    ];
  }
  let text: string;
  if (node instanceof EditBufferRenderable) {
    const value = node.plainText;
    const placeholder =
      !value && node instanceof TextareaRenderable ? node.placeholder : null;
    const hint =
      typeof placeholder === 'string'
        ? placeholder
        : placeholder?.chunks.map((chunk) => chunk.text).join('');
    const label =
      node.id === 'screen-reader-prompt'
        ? node.focused
          ? 'Focused Prompt: {{value}}'
          : 'Prompt: {{value}}'
        : node.focused
          ? 'Focused Input: {{value}}'
          : 'Input: {{value}}';
    text = t(label, { value });
    if (!value && hint)
      text += `\n${t('Placeholder: {{value}}', { value: hint })}`;
    if (node.focused)
      text += `\n${t('Cursor: {{position}}', {
        position: String(cpLen(node.getTextRange(0, node.cursorOffset))),
      })}`;
  } else if (node instanceof MarkdownRenderable) {
    text = markdownToPlainText(node.content);
  } else if (node instanceof TextBufferRenderable) {
    text = node.plainText;
  } else if (node instanceof SelectRenderable) {
    text = node.options
      .map((option, index) =>
        index === node.getSelectedIndex()
          ? t('Selected {{value}}', {
              value: `${index + 1}. ${option.name}${option.description ? `: ${option.description}` : ''}`,
            })
          : `${index + 1}. ${option.name}${option.description ? `: ${option.description}` : ''}`,
      )
      .join('\n');
  } else if (node instanceof TextTableRenderable) {
    text = node.content
      .map((row) =>
        row
          .map((cell) => cell?.map((chunk) => chunk.text).join('') ?? '')
          .join('\t'),
      )
      .join('\n');
  } else {
    const rows = node.getChildren().flatMap(controlRows);
    if (
      !node.id?.startsWith('screen-reader-selected-') &&
      !node.id?.startsWith('screen-reader-unselected-')
    )
      return rows;
    text = rows.map((row) => row.text).join('\n');
  }
  const toggle =
    /^screen-reader-auth-toggle-(focused|unfocused)-(on|off)$/.exec(
      node.id ?? '',
    );
  if (toggle)
    text = t(
      toggle[1] === 'focused'
        ? toggle[2] === 'on'
          ? 'Focused Toggle on: {{value}}'
          : 'Focused Toggle off: {{value}}'
        : toggle[2] === 'on'
          ? 'Toggle on: {{value}}'
          : 'Toggle off: {{value}}',
      {
        value: text
          .trim()
          .replace(/^[›❯▸]\s*/, '')
          .replace(/^[◉○]\uFE0E?\s*/, ''),
      },
    );
  const selected = node.id?.startsWith('screen-reader-selected-');
  if (selected || node.id?.startsWith('screen-reader-unselected-')) {
    text = text.trim().replace(/\s*\n\s*/g, ' ');
    if (
      node.id === 'screen-reader-selected-question-tab' ||
      node.id === 'screen-reader-selected-submit-tab'
    ) {
      text = text.replace(/^▸\s+/, '');
    } else if (
      node.id === 'screen-reader-selected-attachment' ||
      node.id === 'screen-reader-unselected-attachment'
    ) {
      text = text.replace(/^(?:>|📎)\s+/, '');
    } else if (
      selected &&
      !node.id?.includes('tab') &&
      !node.id?.endsWith('category')
    ) {
      text = text.replace(/^[›❯▸>]\s+/, '');
    }
    if (
      node.id === 'screen-reader-selected-option-disabled' ||
      node.id === 'screen-reader-unselected-option-disabled'
    )
      text = t('Disabled {{value}}', { value: text });
    if (selected) text = t('Selected {{value}}', { value: text });
  }
  return text.trim() ? [{ owner: node, text }] : [];
}

export function readScreenReaderControls(node: Renderable): string {
  return controlRows(node)
    .map((row) => row.text)
    .join('\n');
}

/**
 * A settled row's own id survives the remount a dialog or a parked tool call
 * causes, so an unchanged value is not appended again. Only the footer and
 * loading ids qualify: each names exactly one row. Keying on any other id
 * would either lose the de-selection suppression below (a selection id names
 * the cursor's state, not the row) or collapse rows that share one state id
 * (every modality toggle in the same state carries the same auth toggle id).
 */
function controlKey(owner: Renderable): Renderable | string {
  const id = owner.id;
  return id &&
    (id.startsWith('screen-reader-footer-') || id === 'screen-reader-loading')
    ? id
    : owner;
}

interface HistoryOwnerItem {
  kind: string;
  id: string;
  renderId?: string;
  streaming?: boolean;
  done?: boolean;
}

function historyKey(item: HistoryOwnerItem): string {
  return `${item.kind}:${item.id}${item.kind === 'tool' && item.renderId ? `:${item.renderId}` : ''}`;
}

export class ScreenReaderPresentation {
  private owner: object | undefined;
  private history = new Map<string, string>();
  private controls = new Map<Renderable | string, string>();
  private dialogOpen = false;
  private historyWindow = '';
  private items: readonly HistoryOwnerItem[] = [];
  private language: string | undefined;

  constructor(private readonly writer: ScreenReaderOutputWriter) {}

  setHistory(owner: object, items: readonly HistoryOwnerItem[]): void {
    if (this.owner !== owner) {
      this.owner = owner;
      this.history.clear();
      this.controls.clear();
      this.dialogOpen = false;
      this.historyWindow = '';
    } else if (!items.length && this.history.size > 0) {
      // Only the session the reader is still on can be cleared: opening a
      // different, empty session says nothing about the one just left.
      this.writer.appendStatic(t('Conversation cleared.'));
    }
    if (!items.length) this.historyWindow = '';
    this.items = items;
    const current = new Set(items.map((item) => historyKey(item)));
    for (const key of this.history.keys())
      if (!current.has(key)) this.history.delete(key);
  }

  /** `silent` reseeds the dedupe state for a language switch. It may only
   *  re-record rows that were already spoken: recording a row that arrives on
   *  this frame would suppress it on every later frame too. */
  private publishHistory(root: Renderable, silent: boolean): void {
    if (!this.items.length) return;
    const historyRoot = root.findDescendantById('screen-reader-history');
    if (!historyRoot) return;
    const range = historyRoot.findDescendantById(
      'screen-reader-history-window',
    );
    const rangeText = range ? readScreenReaderControls(range) : '';
    if (
      rangeText &&
      rangeText !== this.historyWindow &&
      (!silent || this.historyWindow)
    ) {
      this.historyWindow = rangeText;
      if (!silent) this.writer.appendStatic(rangeText);
    }
    const nodes = new Map<string, Renderable>();
    const collect = (node: Renderable): void => {
      if (node.id?.startsWith('screen-reader-item-')) nodes.set(node.id, node);
      else for (const child of node.getChildren()) collect(child);
    };
    collect(historyRoot);
    for (const item of this.items) {
      const key = historyKey(item);
      if (
        (item.kind === 'assistant' && item.streaming === true) ||
        ((item.kind === 'thinking' || item.kind === 'tool') &&
          item.done === false) ||
        // `task` and `retry` cards are spliced out of the model when they
        // finish, so they have no settled form: speak them once and hold every
        // later progress tick or countdown redraw.
        ((item.kind === 'task' || item.kind === 'retry') &&
          this.history.has(key))
      )
        continue;
      const node = nodes.get(`screen-reader-item-${key}`);
      if (!node) continue;
      const body = readScreenReaderControls(node);
      const role = HISTORY_ROLE_LABELS.has(item.kind)
        ? t(item.kind)
        : item.kind;
      const text = body ? t('{{role}}: {{value}}', { role, value: body }) : '';
      const previous = this.history.get(key) ?? '';
      if (text === previous) continue;
      if (silent && !this.history.has(key)) continue;
      this.history.set(key, text);
      if (!silent)
        this.writer.appendStatic(
          previous ? t('Revision {{value}}', { value: text }) : text,
        );
    }
  }

  /** Erases the dynamic block once no frame can repaint it. */
  dispose(): void {
    this.writer.clearDynamic();
  }

  observeFrames(
    renderer: {
      on(event: 'frame', listener: () => void): unknown;
      off(event: 'frame', listener: () => void): unknown;
    },
    controls: () => Renderable | null,
  ): () => void {
    let active = true;
    const onFrame = () => {
      if (!active) return;
      // Every stored string is localized, so a live language switch recomposes
      // all of them at once. The frame that sees it reseeds the dedupe state
      // instead of replaying the conversation into the append-only scrollback.
      const language = getCurrentLanguage();
      const silent = this.language !== undefined && language !== this.language;
      this.language = language;
      const root = controls();
      if (root) this.publishHistory(root, silent);
      const dialogOpen = Boolean(
        root?.findDescendantById('screen-reader-dialog'),
      );
      if (dialogOpen && !this.dialogOpen) this.writer.appendStatic(t('Dialog'));
      if (!dialogOpen && this.dialogOpen) {
        const prompt = root?.findDescendantById('screen-reader-prompt');
        this.writer.appendStatic(
          prompt instanceof EditBufferRenderable && prompt.focused
            ? t('Dialog closed. Focus: prompt.')
            : t('Dialog closed.'),
        );
      }
      this.dialogOpen = dialogOpen;
      const current = new Map<Renderable | string, string>();
      // The shell unmounts the whole footer behind a dialog or the completion
      // menu, so its rows keep their entry across that gap instead of being
      // re-spoken when they return. Rows whose own appearance is the event —
      // loading, the armed-quit warning, the queue badge — are left out: each
      // must speak again when it returns, even with identical text.
      for (const [key, text] of this.controls)
        if (
          typeof key === 'string' &&
          key.startsWith('screen-reader-footer-') &&
          key !== 'screen-reader-footer-exit' &&
          key !== 'screen-reader-footer-queue'
        )
          current.set(key, text);
      const live: string[] = [];
      for (const row of root ? controlRows(root) : []) {
        const key = controlKey(row.owner);
        // Editable values and repeat-driven readouts are ink's dynamic block:
        // they replace their own lines in place, so neither a keystroke nor a
        // refresh tick appends another copy to the permanent scrollback.
        if (
          row.owner instanceof EditBufferRenderable ||
          row.owner.id?.startsWith('screen-reader-input-line') ||
          row.owner.id?.startsWith('screen-reader-live-')
        ) {
          live.push(row.text);
          continue;
        }
        const previous = this.controls.get(key);
        if (silent && previous === undefined) continue;
        current.set(key, row.text);
        if (
          !silent &&
          row.text !== previous &&
          previous !== t('Selected {{value}}', { value: row.text })
        )
          this.writer.appendStatic(row.text);
      }
      this.controls = current;
      this.writer.updateDynamic(live.join('\n'));
    };
    renderer.on('frame', onFrame);
    return () => {
      active = false;
      renderer.off('frame', onFrame);
    };
  }
}
