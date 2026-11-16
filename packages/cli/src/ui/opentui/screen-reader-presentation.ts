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

interface ControlRow {
  owner: Renderable;
  text: string;
}

function inputLineText(node: Renderable): string {
  if (!node.visible || node.isDestroyed) return '';
  if (node.id === 'screen-reader-protected-input') return 'Protected input';
  if (node instanceof TextBufferRenderable) return node.plainText;
  return node.getChildren().map(inputLineText).join('');
}

/** Reads public semantic values, never the painted cell buffer or colors. */
function controlRows(node: Renderable): ControlRow[] {
  if (!node.visible || node.isDestroyed || node.id === 'screen-reader-history')
    return [];
  if (node.id === 'screen-reader-protected-input')
    return [{ owner: node, text: 'Protected input' }];
  if (node.id === 'screen-reader-input-line')
    return [{ owner: node, text: inputLineText(node) }];
  let text: string;
  if (node instanceof EditBufferRenderable) {
    const value = node.plainText;
    const placeholder =
      !value && node instanceof TextareaRenderable ? node.placeholder : null;
    const hint =
      typeof placeholder === 'string'
        ? placeholder
        : placeholder?.chunks.map((chunk) => chunk.text).join('');
    text = `${node.focused ? 'Focused ' : ''}${node.id === 'screen-reader-prompt' ? 'Prompt' : 'Input'}: ${value}${!value && hint ? `\nPlaceholder: ${hint}` : ''}${node.focused ? `\nCursor: ${node.cursorOffset}` : ''}`;
  } else if (node instanceof MarkdownRenderable) {
    text = markdownToPlainText(node.content);
  } else if (node instanceof TextBufferRenderable) {
    text = node.plainText;
  } else if (node instanceof SelectRenderable) {
    text = node.options
      .map(
        (option, index) =>
          `${index === node.getSelectedIndex() ? 'Selected ' : ''}${index + 1}. ${option.name}${option.description ? `: ${option.description}` : ''}`,
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
  if (node.id?.startsWith('screen-reader-selected-')) {
    text = text.trim().replace(/\s*\n\s*/g, ' ');
    if (!node.id.includes('tab') && !node.id.endsWith('category'))
      text = text.replace(/^[›❯▸>]\s+/, '');
    text = `Selected ${text}`;
  } else if (node.id?.startsWith('screen-reader-unselected-'))
    text = text.trim().replace(/\s*\n\s*/g, ' ');
  return text.trim() ? [{ owner: node, text }] : [];
}

export function readScreenReaderControls(node: Renderable): string {
  return controlRows(node)
    .map((row) => row.text)
    .join('\n');
}

interface HistoryOwnerItem {
  kind: string;
  id: string;
  renderId?: string;
}

function historyKey(item: HistoryOwnerItem): string {
  return `${item.kind}:${item.id}${item.kind === 'tool' && item.renderId ? `:${item.renderId}` : ''}`;
}

export class ScreenReaderPresentation {
  private owner: object | undefined;
  private history = new Map<string, string>();
  private controls = new Map<Renderable, string>();
  private dialogOpen = false;
  private items: readonly HistoryOwnerItem[] = [];

  constructor(private readonly writer: ScreenReaderOutputWriter) {}

  setHistory(owner: object, items: readonly HistoryOwnerItem[]): void {
    const hadHistory = this.history.size > 0;
    if (this.owner !== owner) {
      this.owner = owner;
      this.history.clear();
      this.controls.clear();
      this.dialogOpen = false;
    }
    if (!items.length && hadHistory)
      this.writer.appendStatic('Conversation cleared.');
    this.items = items;
    const current = new Set(items.map((item) => historyKey(item)));
    for (const key of this.history.keys())
      if (!current.has(key)) this.history.delete(key);
  }

  private publishHistory(root: Renderable): void {
    const historyRoot = root.findDescendantById('screen-reader-history');
    if (!historyRoot) return;
    const nodes = new Map<string, Renderable>();
    const collect = (node: Renderable): void => {
      if (node.id?.startsWith('screen-reader-item-')) nodes.set(node.id, node);
      else for (const child of node.getChildren()) collect(child);
    };
    collect(historyRoot);
    for (const item of this.items) {
      const key = historyKey(item);
      const node = nodes.get(`screen-reader-item-${key}`);
      if (!node) continue;
      const body = readScreenReaderControls(node);
      const text = body ? `${item.kind}: ${body}` : '';
      const previous = this.history.get(key) ?? '';
      if (text === previous) continue;
      this.history.set(key, text);
      this.writer.appendStatic(previous ? `Revision ${text}` : text);
    }
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
      const root = controls();
      if (root) this.publishHistory(root);
      const dialogOpen = Boolean(
        root?.findDescendantById('screen-reader-dialog'),
      );
      if (dialogOpen && !this.dialogOpen) this.writer.appendStatic('Dialog');
      if (!dialogOpen && this.dialogOpen) {
        const prompt = root?.findDescendantById('screen-reader-prompt');
        this.writer.appendStatic(
          prompt instanceof EditBufferRenderable && prompt.focused
            ? 'Dialog closed. Focus: prompt.'
            : 'Dialog closed.',
        );
      }
      this.dialogOpen = dialogOpen;
      const current = new Map<Renderable, string>();
      for (const row of root ? controlRows(root) : []) {
        const previous = this.controls.get(row.owner);
        if (row.text !== previous && previous !== `Selected ${row.text}`)
          this.writer.appendStatic(row.text);
        current.set(row.owner, row.text);
      }
      this.controls = current;
    };
    renderer.on('frame', onFrame);
    return () => {
      active = false;
      renderer.off('frame', onFrame);
    };
  }
}
