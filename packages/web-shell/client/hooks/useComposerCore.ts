import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder,
  tooltips,
  type DecorationSet,
} from '@codemirror/view';
import {
  EditorState,
  Compartment,
  Prec,
  StateEffect,
  StateField,
} from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  moveCompletionSelection,
  startCompletion,
  type Completion,
} from '@codemirror/autocomplete';
import { minimalSetup } from 'codemirror';
import type { CommandInfo } from '../adapters/types';
import type { PromptImage } from '../adapters/promptTypes';
import {
  useOptionalWorkspace,
  type UseDaemonFollowupSuggestionReturn,
} from '@qwen-code/webui/daemon-react-sdk';
import {
  getImplicitTabCompletion,
  getMissingSlashPrefixCompletion,
  getSlashCommandCompletionResult,
  type SkillInfo,
  type SlashCommandCompletionResult,
} from '../completions/slashCompletion';
import {
  DEFAULT_COMMAND_CATEGORY_ORDER,
  type CommandDisplayCategoryOrder,
} from '../utils/commandDisplay';
import { createAtCompletionSource } from '../completions/atCompletion';
import { useInputHistory } from '../hooks/useInputHistory';
import { useI18n } from '../i18n';
import {
  inputHighlight,
  inputHighlightTheme,
} from '../extensions/inputHighlight';
import { isEditableTarget } from '../utils/dom';
import type {
  WebShellComposerApi,
  WebShellComposerInput,
  WebShellComposerTag,
  WebShellComposerTagOptions,
  WebShellComposerTextOptions,
} from '../customization';

// ---- Large paste handling (shared utilities) ----

const LARGE_PASTE_CHAR_THRESHOLD = 1000;
const LARGE_PASTE_LINE_THRESHOLD = 10;
const TOOLTIP_STYLE_ID = 'web-shell-tooltip-styles';
const TOOLTIP_STYLES = `
[data-web-shell-tooltip-portal] {
  pointer-events: none;
}

[data-web-shell-tooltip-portal] .cm-tooltip {
  z-index: var(--web-shell-tooltip-z-index, 1000);
  pointer-events: auto;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete {
  --web-shell-completion-label-width: 20ch;
  --web-shell-completion-column-gap: 2ch;
  --web-shell-completion-detail-start: calc(
    var(--web-shell-completion-label-width) +
      var(--web-shell-completion-column-gap)
  );
  min-width: 500px !important;
  max-width: 700px !important;
  max-height: 400px !important;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4) !important;
  background: var(--bg-primary, #0d0d0d) !important;
  border: 1px solid var(--border-color, #2a2a2a) !important;
  border-radius: 6px !important;
  overflow: visible;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete > ul {
  max-height: 380px !important;
  overflow: auto;
  border-radius: 6px;
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  scrollbar-width: thin;
  scrollbar-color: var(--border-color) transparent;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete > ul::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete > ul::-webkit-scrollbar-track {
  background: transparent;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete > ul::-webkit-scrollbar-thumb {
  background: var(--border-color);
  border-radius: 3px;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete ul li {
  display: flex !important;
  align-items: baseline;
  min-width: 0;
  padding: 4px 8px !important;
  color: var(--text-primary, #e4e4e4) !important;
  overflow: hidden;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete ul li:hover {
  background: var(--bg-tertiary, #1e1e1e) !important;
  color: var(--text-primary, #e4e4e4) !important;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete ul li[aria-selected] {
  background: var(--bg-tertiary, #1e1e1e) !important;
  color: var(--text-primary, #e4e4e4) !important;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete ul li:is(:hover, [aria-selected]) .cm-completionLabel {
  color: var(--accent-color, #4a9eff);
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete completion-section {
  display: block !important;
  height: 0;
  margin: 6px 10px 3px;
  padding: 0 !important;
  border-bottom: 1px solid var(--border-color) !important;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete completion-section:first-of-type {
  display: none !important;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete .cm-completionLabel {
  font-family: var(--font-mono, monospace);
  flex-shrink: 0;
  width: var(--web-shell-completion-label-width);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete .cm-completionDetail {
  flex: 1 1 auto;
  min-width: 0;
  font-style: normal;
  color: var(--text-secondary);
  font-size: 13px;
  margin-left: var(--web-shell-completion-column-gap);
  opacity: 0.8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete ul li.cm-file-completion .cm-completionLabel {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
  max-width: none;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete ul li.cm-command-info-completion {
  display: grid !important;
  grid-template-columns: var(--web-shell-completion-label-width) minmax(0, 1fr);
  column-gap: var(--web-shell-completion-column-gap);
  align-items: baseline !important;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete ul li.cm-command-info-completion .cm-completionLabel {
  min-width: 0;
  max-width: none;
}

[data-web-shell-tooltip-portal] .cm-tooltip-autocomplete ul li.cm-command-info-completion .cm-completionDetail {
  margin-left: 0;
  white-space: nowrap;
}

[data-web-shell-tooltip-portal] .cm-tooltip.cm-completionInfo {
  z-index: calc(var(--web-shell-tooltip-z-index, 1000) + 1);
  width: min(320px, calc(100vw - 32px));
  max-width: min(320px, calc(100vw - 32px)) !important;
  max-height: min(280px, calc(100vh - 32px));
  padding: 8px 10px;
  overflow: auto;
  border: 1px solid var(--border-color, #2a2a2a);
  border-radius: 6px;
  background: var(--bg-secondary, #161616);
  color: var(--text-primary, #e4e4e4);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 13px;
  line-height: 1.45;
  white-space: pre-line;
  overflow-wrap: anywhere;
  scrollbar-width: thin;
  scrollbar-color: var(--border-color) transparent;
}

[data-web-shell-tooltip-portal] .cm-completionInfo-hover {
  pointer-events: auto;
  z-index: calc(var(--web-shell-tooltip-z-index, 1000) + 1);
}

[data-web-shell-tooltip-portal] .cm-tooltip.cm-completionInfo::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

[data-web-shell-tooltip-portal] .cm-tooltip.cm-completionInfo::-webkit-scrollbar-track {
  background: transparent;
}

[data-web-shell-tooltip-portal] .cm-tooltip.cm-completionInfo::-webkit-scrollbar-thumb {
  background: var(--border-color);
  border-radius: 3px;
}

[data-web-shell-tooltip-portal] .cm-completionInfo.cm-completionInfo-right {
  margin-left: var(--web-shell-completion-column-gap);
}

[data-web-shell-tooltip-portal] .cm-completionInfo.cm-completionInfo-right-narrow {
  left: var(--web-shell-completion-detail-start);
}

[data-web-shell-tooltip-portal] .cm-completionInfo.cm-completionInfo-left {
  margin-right: var(--web-shell-completion-column-gap);
}

[data-web-shell-tooltip-portal] .cm-completionInfo.cm-completionInfo-left-narrow {
  right: var(--web-shell-completion-detail-start);
}
`;

function ensureTooltipStyles() {
  if (document.getElementById(TOOLTIP_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = TOOLTIP_STYLE_ID;
  style.textContent = TOOLTIP_STYLES;
  document.head.appendChild(style);
}

/**
 * Compute the next selected index for an open, composer-owned slash-command
 * menu. History-recalled slash commands suppress the menu before this runs, so
 * arrow keys can keep walking input history in that path.
 * Returns null when there is nothing to select.
 */
function nextSlashSelectionIndex(
  selectedIndex: number,
  count: number,
  direction: 'up' | 'down',
): number | null {
  if (count <= 0) return null;
  const delta = direction === 'up' ? -1 : 1;
  return (((selectedIndex + delta) % count) + count) % count;
}

function isSlashCommandCompletion(completion: Completion): boolean {
  return (
    typeof completion.apply === 'string' &&
    completion.apply.trim().startsWith('/')
  );
}

function hasCommandHoverInfo(completion: Completion): boolean {
  return isSlashCommandCompletion(completion);
}

function getCompletionInfoTitle(completion: Completion): string {
  if (typeof completion.apply === 'string') {
    return completion.apply.trim();
  }
  return completion.displayLabel?.trim() || completion.label;
}

function clearCompletionHoverInfo(portal: Element) {
  portal.querySelectorAll('.cm-completionInfo-hover').forEach((node) => {
    node.remove();
  });
}

function showCompletionHoverInfo(
  anchor: HTMLElement,
  completion: Completion,
  event: MouseEvent,
) {
  if (!completion.detail || !hasCommandHoverInfo(completion)) return;
  const portal = anchor.closest('[data-web-shell-tooltip-portal]');
  if (!portal) return;

  let info = portal.querySelector<HTMLElement>('.cm-completionInfo-hover');
  if (!info) {
    info = document.createElement('div');
    info.className =
      'cm-tooltip cm-completionInfo cm-completionInfo-hover cm-completionInfo-right-narrow';
    portal.appendChild(info);
  }
  info.textContent = `${getCompletionInfoTitle(completion)}\n\n${completion.detail}`;
  const hideTimerId = info.dataset['hideTimerId'];
  if (hideTimerId) {
    window.clearTimeout(Number(hideTimerId));
    delete info.dataset['hideTimerId'];
  }

  const infoRect = info.getBoundingClientRect();
  const offsetX = 18;
  const offsetY = 12;
  const padding = 12;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const preferredLeft = event.clientX + offsetX;
  const left =
    preferredLeft + infoRect.width + padding > viewportWidth
      ? Math.max(padding, event.clientX - infoRect.width - offsetX)
      : preferredLeft;
  const top = Math.min(
    Math.max(padding, event.clientY + offsetY),
    Math.max(padding, viewportHeight - infoRect.height - padding),
  );

  info.style.position = 'fixed';
  info.style.left = `${left}px`;
  info.style.top = `${top}px`;
  info.style.right = 'auto';
  info.style.bottom = 'auto';
}

function scheduleClearCompletionHoverInfo(portal: Element) {
  const info = portal.querySelector<HTMLElement>('.cm-completionInfo-hover');
  if (!info) return;
  const timerId = window.setTimeout(() => {
    info.remove();
  }, 180);
  info.dataset['hideTimerId'] = String(timerId);
  info.addEventListener(
    'mouseenter',
    () => {
      window.clearTimeout(timerId);
      delete info.dataset['hideTimerId'];
    },
    { once: true },
  );
  info.addEventListener(
    'mouseleave',
    () => {
      info.remove();
    },
    { once: true },
  );
}

function renderCompletionHoverInfo(completion: Completion): HTMLElement | null {
  if (!completion.detail || !hasCommandHoverInfo(completion)) return null;
  const anchor = document.createElement('span');
  anchor.className = 'cm-command-hover-info-anchor';
  anchor.setAttribute('aria-hidden', 'true');
  queueMicrotask(() => {
    const option = anchor.closest('li');
    if (!option || option.hasAttribute('data-web-shell-hover-info')) return;
    option.setAttribute('data-web-shell-hover-info', 'true');
    option.addEventListener('mouseenter', (event) => {
      showCompletionHoverInfo(anchor, completion, event);
    });
    option.addEventListener('mouseleave', () => {
      const portal = anchor.closest('[data-web-shell-tooltip-portal]');
      if (portal) scheduleClearCompletionHoverInfo(portal);
    });
  });
  return anchor;
}

export function normalizePastedText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function isLargePaste(text: string): boolean {
  return (
    [...text].length > LARGE_PASTE_CHAR_THRESHOLD ||
    text.split('\n').length > LARGE_PASTE_LINE_THRESHOLD
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface LargePastePlaceholderResult {
  placeholderText: string;
  nextPasteId: number;
}

export function createLargePastePlaceholder(
  pendingPastes: Map<string, string>,
  nextPasteId: number,
  pasted: string,
): LargePastePlaceholderResult {
  const charCount = [...pasted].length;
  const base = `[Pasted Content ${charCount} chars]`;
  const placeholderText = nextPasteId === 1 ? base : `${base} #${nextPasteId}`;
  pendingPastes.set(placeholderText, pasted);
  return { placeholderText, nextPasteId: nextPasteId + 1 };
}

export function prunePendingPastes(
  pendingPastes: Map<string, string>,
  docText: string,
): number | null {
  for (const placeholderText of pendingPastes.keys()) {
    if (!docText.includes(placeholderText)) {
      pendingPastes.delete(placeholderText);
    }
  }
  return pendingPastes.size === 0 ? 1 : null;
}

export function expandLargePastePlaceholders(
  pendingPastes: Map<string, string>,
  text: string,
): string {
  if (pendingPastes.size === 0) return text;
  const placeholders = [...pendingPastes.keys()].sort(
    (a, b) => b.length - a.length,
  );
  const pattern = new RegExp(placeholders.map(escapeRegExp).join('|'), 'g');
  return text.replace(
    pattern,
    (placeholderText) => pendingPastes.get(placeholderText) ?? placeholderText,
  );
}

// ---- Tag serialization (shared) ----

export function serializeComposerTag(tag: WebShellComposerTag): string {
  return tag.value?.trim() || tag.label?.trim() || tag.id;
}

function serializeComposerTags(tags: readonly WebShellComposerTag[]): string {
  return tags.map(serializeComposerTag).join('\n');
}

export function getComposerTagLabel(tag: WebShellComposerTag): string {
  return tag.label?.trim() ?? '';
}

export function getComposerTagValue(tag: WebShellComposerTag): string {
  return tag.value?.trim() ?? '';
}

export function getComposerTagDisplay(tag: WebShellComposerTag): string {
  return getComposerTagValue(tag) || getComposerTagLabel(tag) || tag.id;
}

export function buildComposerPrompt(
  text: string,
  tags: readonly WebShellComposerTag[],
): string {
  const tagText = serializeComposerTags(tags);
  if (!tagText) return text;
  if (!text) return tagText;
  return `${tagText}\n\n${text}`;
}

// ---- Inline tag CodeMirror extension (shared) ----

interface InlineTagRange {
  from: number;
  to: number;
  tag: WebShellComposerTag;
}

interface InlineTagDecorationSpec {
  tag: WebShellComposerTag;
}

export const addInlineTagEffect = StateEffect.define<InlineTagRange>({
  map: (value) => value,
});
export const removeInlineTagEffect = StateEffect.define<{
  predicate?: (tag: WebShellComposerTag) => boolean;
}>();
export const clearInlineTagsEffect = StateEffect.define<void>();

class ComposerTagWidget extends WidgetType {
  constructor(private readonly tag: WebShellComposerTag) {
    super();
  }

  eq(other: ComposerTagWidget): boolean {
    return (
      this.tag.id === other.tag.id &&
      this.tag.label === other.tag.label &&
      this.tag.value === other.tag.value &&
      this.tag.removable === other.tag.removable
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const chip = document.createElement('span');
    chip.style.cssText =
      'display:inline-flex;align-items:center;max-width:min(44ch,100%);min-height:20px;margin:0 0.25ch;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-tertiary);color:var(--text-primary);font-family:var(--font-mono,monospace);font-size:12px;line-height:1.2;vertical-align:baseline;';
    const tagLabel = getComposerTagLabel(this.tag);
    const tagValue = getComposerTagValue(this.tag);

    if (tagLabel) {
      const label = document.createElement('span');
      label.style.cssText =
        'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 0 3px 7px;color:var(--accent-color);';
      label.textContent = tagLabel;
      chip.appendChild(label);
    }

    if (tagValue) {
      const value = document.createElement('span');
      value.style.cssText =
        'max-width:32ch;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 0 3px 0.5ch;color:var(--text-secondary);';
      value.textContent = tagValue;
      chip.appendChild(value);
    } else if (!tagLabel) {
      const fallback = document.createElement('span');
      fallback.style.cssText =
        'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 0 3px 7px;color:var(--accent-color);';
      fallback.textContent = this.tag.id;
      chip.appendChild(fallback);
    }

    if (this.tag.removable !== false) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute(
        'aria-label',
        `Remove ${getComposerTagDisplay(this.tag)}`,
      );
      remove.style.cssText =
        'flex:0 0 auto;width:22px;height:22px;padding:0;border:0;background:transparent;color:var(--text-dimmed);font:inherit;line-height:22px;cursor:pointer;';
      remove.textContent = '×';
      remove.addEventListener('mousedown', (event) => event.preventDefault());
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        const changes: Array<{ from: number; to: number; insert: string }> = [];
        view.state
          .field(inlineComposerTagField)
          .between(0, view.state.doc.length, (from, to, value) => {
            const tag = (value.spec as Partial<InlineTagDecorationSpec>).tag;
            if (tag?.id === this.tag.id && tag.removable !== false) {
              changes.push({ from, to, insert: '' });
            }
          });
        if (changes.length === 0) return;
        view.dispatch({
          changes,
          effects: removeInlineTagEffect.of({
            predicate: (tag) => tag.id === this.tag.id,
          }),
          scrollIntoView: true,
        });
        view.focus();
      });
      remove.addEventListener('mouseenter', () => {
        remove.style.color = 'var(--error-color)';
      });
      remove.addEventListener('mouseleave', () => {
        remove.style.color = 'var(--text-dimmed)';
      });
      chip.appendChild(remove);
    }

    return chip;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function createInlineTagDecoration(range: InlineTagRange) {
  const spec = {
    widget: new ComposerTagWidget(range.tag),
    inclusive: false,
    tag: range.tag,
  };
  return Decoration.replace(spec).range(range.from, range.to);
}

const inlineComposerTagField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(tags, tr) {
    let next = tags.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(addInlineTagEffect)) {
        next = next.update({ add: [createInlineTagDecoration(effect.value)] });
      } else if (effect.is(removeInlineTagEffect)) {
        next = next.update({
          filter: (_from, _to, value) => {
            const tag = (value.spec as Partial<InlineTagDecorationSpec>).tag;
            if (!tag) return true;
            return effect.value.predicate ? !effect.value.predicate(tag) : true;
          },
        });
      } else if (effect.is(clearInlineTagsEffect)) {
        next = Decoration.none;
      }
    }
    return next;
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
});

export function getInlineComposerTags(view: EditorView): WebShellComposerTag[] {
  const tags: WebShellComposerTag[] = [];
  view.state
    .field(inlineComposerTagField)
    .between(0, view.state.doc.length, (_from, _to, value) => {
      const tag = (value.spec as Partial<InlineTagDecorationSpec>).tag;
      if (tag) tags.push(tag);
    });
  return tags;
}

// ---- EditorHandle type (shared) ----

export interface EditorHandle extends WebShellComposerApi {
  clearText(): void;
  focus(): void;
  getText(): string;
  hasInput(): boolean;
  retryLast(): void;
}

// ---- Compartments (shared) ----

export const editableCompartment = new Compartment();
export const placeholderCompartment = new Compartment();
export const followupGhostCompartment = new Compartment();

function getFollowupCompletion(
  text: string,
  suggestion: string | null | undefined,
): string | null {
  if (!suggestion) return null;
  if (text.length === 0) return suggestion;
  return suggestion.startsWith(text) ? suggestion : null;
}

function getFollowupRemainder(
  text: string,
  suggestion: string | null | undefined,
): string | null {
  const completion = getFollowupCompletion(text, suggestion);
  if (!completion || text.length === 0) return null;
  const remainder = completion.slice(text.length);
  return remainder.length > 0 ? remainder : null;
}

class FollowupGhostWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  eq(other: FollowupGhostWidget): boolean {
    return this.text === other.text;
  }

  toDOM(): HTMLElement {
    const ghost = document.createElement('span');
    ghost.className = 'cm-followup-ghost';
    ghost.textContent = this.text;
    return ghost;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function createFollowupGhostExtension(suggestion: string | null) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: {
        view: EditorView;
        docChanged: boolean;
        selectionSet: boolean;
      }) {
        if (update.docChanged || update.selectionSet) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      private buildDecorations(view: EditorView): DecorationSet {
        if (!suggestion) return Decoration.none;
        const selection = view.state.selection.main;
        const text = view.state.doc.toString();
        const remainder = getFollowupRemainder(text, suggestion);
        if (!remainder || !selection.empty || selection.head !== text.length) {
          return Decoration.none;
        }
        return Decoration.set([
          Decoration.widget({
            widget: new FollowupGhostWidget(remainder),
            side: 1,
          }).range(text.length),
        ]);
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
    },
  );
}

// ---- Hook options ----

export interface UseComposerCoreOptions {
  onSubmit: (text: string, images?: PromptImage[]) => boolean | void;
  onCycleMode?: () => void;
  onToggleShortcuts?: () => void;
  disabled?: boolean;
  placeholderText?: string;
  commands: CommandInfo[];
  skills?: SkillInfo[];
  slashCommandCategoryOrder?: CommandDisplayCategoryOrder;
  queuedMessages?: string[];
  onPopQueuedMessages?: () => string | null;
  onClearQueuedMessages?: () => boolean;
  currentMode?: string;
  onFocusFooter?: () => boolean;
  dialogOpen?: boolean;
  followupState?: UseDaemonFollowupSuggestionReturn['followupState'];
  onAcceptFollowup?: UseDaemonFollowupSuggestionReturn['onAcceptFollowup'];
  onDismissFollowup?: UseDaemonFollowupSuggestionReturn['onDismissFollowup'];
  sessionName?: string;
  composerInput?: WebShellComposerInput;
  composerInputVersion?: number;
  /** CodeMirror theme extension for the editor view. Each variant provides its own. */
  editorTheme: Parameters<typeof EditorView.theme>[0];
}

export interface SearchState {
  searchMode: boolean;
  searchQuery: string;
  searchMatches: string[];
  searchActiveIndex: number;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  searchUiRef: React.RefObject<HTMLDivElement | null>;
  openHistorySearch: () => void;
  closeSearch: (restoreDraft: boolean, keepFocus?: boolean) => void;
  submitSearchMatch: (match: string) => void;
  handleSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleSearchInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleSearchCompositionEnd: (
    e: React.CompositionEvent<HTMLInputElement>,
  ) => void;
}

export interface SlashMenuState extends SlashCommandCompletionResult {
  selectedIndex: number;
}

type MultilineHistoryBoundary = 'editor' | 'handled' | 'history';

function handleMultilineHistoryBoundary(
  view: EditorView,
  direction: 'up' | 'down',
): MultilineHistoryBoundary {
  const doc = view.state.doc;
  if (doc.lines <= 1) return 'history';

  const selection = view.state.selection.main;
  if (!selection.empty) return 'editor';

  const head = selection.head;
  const line = doc.lineAt(head);

  // Let CodeMirror handle normal multi-line cursor movement first. Once the
  // cursor is on the edge line, one more arrow key snaps to the true edge;
  // the next press can browse prompt history instead of feeling stuck.
  if (direction === 'up') {
    if (line.number > 1) return 'editor';
    if (head > line.from) {
      view.dispatch({
        selection: { anchor: line.from },
        scrollIntoView: true,
      });
      return 'handled';
    }
    return 'history';
  }

  if (line.number < doc.lines) return 'editor';
  if (head < line.to) {
    view.dispatch({
      selection: { anchor: line.to },
      scrollIntoView: true,
    });
    return 'handled';
  }
  return 'history';
}

export interface UseComposerCoreReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  viewRef: React.RefObject<EditorView | null>;
  focus: () => void;
  submitText: () => void;
  clearText: () => void;
  getText: () => string;
  hasInput: () => boolean;
  hasContent: boolean;
  handle: EditorHandle;
  pastedImages: PromptImage[];
  removeImage: (index: number) => void;
  composerTags: WebShellComposerTag[];
  removeTopTag: (id: string) => void;
  addTags: (
    tags: readonly WebShellComposerTag[],
    options?: WebShellComposerTagOptions,
  ) => void;
  removeInlineTags: (predicate?: (tag: WebShellComposerTag) => boolean) => void;
  insertText: (text: string, options?: WebShellComposerTextOptions) => void;
  setText: (text: string) => void;
  submit: (input?: WebShellComposerInput) => void;
  clear: (options?: { text?: boolean; tags?: boolean }) => void;
  retryLast: () => void;
  replaceEditorText: (text: string) => void;
  shellMode: boolean;
  setShellMode: React.Dispatch<React.SetStateAction<boolean>>;
  toggleShellMode: () => void;
  currentMode: string;
  sessionName: string | undefined;
  searchState: SearchState;
  navigatePrevHistory: () => void;
  navigateNextHistory: () => void;
  showShortcutHints: boolean;
  followupState: UseDaemonFollowupSuggestionReturn['followupState'];
  disabled: boolean;
  onAcceptFollowup: UseDaemonFollowupSuggestionReturn['onAcceptFollowup'];
  onDismissFollowup: UseDaemonFollowupSuggestionReturn['onDismissFollowup'];
  slashMenu: SlashMenuState | null;
  closeSlashMenu: () => void;
  selectSlashCompletion: (index: number) => boolean;
  acceptSlashCompletion: (index?: number) => boolean;
}

export function useComposerCore(
  options: UseComposerCoreOptions,
): UseComposerCoreReturn {
  const {
    onSubmit,
    onCycleMode,
    onToggleShortcuts,
    disabled = false,
    placeholderText = 'Type a message...',
    commands,
    skills = [],
    slashCommandCategoryOrder,
    queuedMessages = [],
    onPopQueuedMessages,
    onClearQueuedMessages,
    currentMode = 'default',
    onFocusFooter,
    dialogOpen = false,
    followupState,
    onAcceptFollowup,
    onDismissFollowup,
    sessionName,
    composerInput,
    composerInputVersion,
    editorTheme,
  } = options;

  const workspace = useOptionalWorkspace();
  const { language, t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onCycleModeRef = useRef(onCycleMode);
  onCycleModeRef.current = onCycleMode;
  const onToggleShortcutsRef = useRef(onToggleShortcuts);
  onToggleShortcutsRef.current = onToggleShortcuts;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const skillsRef = useRef(skills);
  skillsRef.current = skills;
  const slashCommandCategoryOrderRef = useRef(slashCommandCategoryOrder);
  slashCommandCategoryOrderRef.current = slashCommandCategoryOrder;
  const tRef = useRef(t);
  tRef.current = t;
  const queuedMessagesRef = useRef(queuedMessages);
  queuedMessagesRef.current = queuedMessages;
  const onPopQueuedMessagesRef = useRef(onPopQueuedMessages);
  onPopQueuedMessagesRef.current = onPopQueuedMessages;
  const onClearQueuedMessagesRef = useRef(onClearQueuedMessages);
  onClearQueuedMessagesRef.current = onClearQueuedMessages;
  const followupStateRef = useRef(followupState);
  followupStateRef.current = followupState;
  const onAcceptFollowupRef = useRef(onAcceptFollowup);
  onAcceptFollowupRef.current = onAcceptFollowup;
  const onDismissFollowupRef = useRef(onDismissFollowup);
  onDismissFollowupRef.current = onDismissFollowup;
  const onFocusFooterRef = useRef(onFocusFooter);
  onFocusFooterRef.current = onFocusFooter;
  const languageRef = useRef(language);
  languageRef.current = language;
  const workspaceActionsRef = useRef(workspace?.actions);
  workspaceActionsRef.current = workspace?.actions;
  const [shellMode, setShellMode] = useState(false);
  const shellModeRef = useRef(shellMode);
  shellModeRef.current = shellMode;
  const toggleShellMode = useCallback(() => {
    if (followupStateRef.current?.isVisible) {
      onDismissFollowupRef.current?.();
    }
    setShellMode((value) => !value);
    viewRef.current?.focus();
  }, []);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<string[]>([]);
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchUiRef = useRef<HTMLDivElement>(null);
  const searchDraftRef = useRef('');
  const [pastedImages, setPastedImages] = useState<PromptImage[]>([]);
  const pastedImagesRef = useRef<PromptImage[]>([]);
  const pendingPastesRef = useRef<Map<string, string>>(new Map());
  const nextPasteIdRef = useRef(1);
  const [composerTags, setComposerTags] = useState<WebShellComposerTag[]>([]);
  const composerTagsRef = useRef<WebShellComposerTag[]>([]);
  composerTagsRef.current = composerTags;
  const composerInputRef = useRef(composerInput);
  composerInputRef.current = composerInput;
  const submitTextRef = useRef<
    (
      view: EditorView,
      textOverride?: string,
      tagsOverride?: readonly WebShellComposerTag[],
    ) => boolean
  >(() => true);
  const autoTriggerRef = useRef<{ text: string; from: number } | null>(null);
  const [slashMenu, setSlashMenuState] = useState<SlashMenuState | null>(null);
  const slashMenuRef = useRef<SlashMenuState | null>(null);

  // True while the user is paging through input history with the arrow keys
  // and has not typed since. Unlike history.isNavigating() (which stays set
  // until submit), this resets the moment the user edits the text, so a
  // recalled slash command like "/theme" keeps the slash menu closed while a
  // freshly typed "/" lets arrows drive the menu. See the ArrowUp/ArrowDown
  // keymap handlers.
  const historyBrowseActiveRef = useRef(false);

  const setSlashMenu = useCallback((next: SlashMenuState | null) => {
    slashMenuRef.current = next;
    setSlashMenuState(next);
  }, []);

  const refreshSlashMenuForView = useCallback(
    (view: EditorView | null, preferredIndex?: number) => {
      if (!view || disabledRef.current || shellModeRef.current) {
        setSlashMenu(null);
        return;
      }
      // While browsing history, a recalled slash command (e.g. "/theme")
      // should not pop its argument menu — the user is browsing, not composing.
      // Editing the line re-arms it (historyBrowseActiveRef clears on edit).
      if (historyBrowseActiveRef.current) {
        setSlashMenu(null);
        return;
      }
      const selection = view.state.selection.main;
      if (!selection.empty) {
        setSlashMenu(null);
        return;
      }
      const result = getSlashCommandCompletionResult(
        view.state.doc.toString(),
        selection.head,
        commandsRef.current,
        skillsRef.current,
        languageRef.current,
        (key) => tRef.current(key),
        slashCommandCategoryOrderRef.current ?? DEFAULT_COMMAND_CATEGORY_ORDER,
      );
      if (!result) {
        setSlashMenu(null);
        return;
      }
      const currentIndex =
        preferredIndex ?? slashMenuRef.current?.selectedIndex ?? 0;
      const selectedIndex = Math.max(
        0,
        Math.min(currentIndex, result.items.length - 1),
      );
      setSlashMenu({ ...result, selectedIndex });
    },
    [setSlashMenu],
  );

  const closeSlashMenu = useCallback(() => {
    setSlashMenu(null);
  }, [setSlashMenu]);

  const selectSlashCompletion = useCallback(
    (index: number) => {
      const current = slashMenuRef.current;
      if (!current || index < 0 || index >= current.items.length) {
        return false;
      }
      if (current.selectedIndex === index) return true;
      setSlashMenu({ ...current, selectedIndex: index });
      return true;
    },
    [setSlashMenu],
  );

  const moveSlashCompletionSelection = useCallback(
    (direction: 'up' | 'down') => {
      const current = slashMenuRef.current;
      if (!current) return false;
      const nextIndex = nextSlashSelectionIndex(
        current.selectedIndex,
        current.items.length,
        direction,
      );
      if (nextIndex === null) return false;
      setSlashMenu({ ...current, selectedIndex: nextIndex });
      return true;
    },
    [setSlashMenu],
  );

  const acceptSlashCompletion = useCallback((index?: number) => {
    const view = viewRef.current;
    const current = slashMenuRef.current;
    if (!view || !current) return false;
    const item = current.items[index ?? current.selectedIndex];
    if (!item) return false;
    view.dispatch({
      changes: { from: current.from, to: current.to, insert: item.apply },
      selection: { anchor: current.from + item.apply.length },
      scrollIntoView: true,
    });
    view.focus();
    return true;
  }, []);

  // Track whether editor has content for send button state
  const [hasContent, setHasContent] = useState(false);

  // Update hasContent when tags or images change
  useEffect(() => {
    const view = viewRef.current;
    const text = view?.state.doc.toString().trim() ?? '';
    setHasContent(
      text.length > 0 || composerTags.length > 0 || pastedImages.length > 0,
    );
  }, [composerTags, pastedImages]);

  const promptHistory = useInputHistory();
  const shellHistory = useInputHistory('qwen-web-shell-command-history');

  const {
    push,
    navigateUp,
    navigateDown,
    isNavigating,
    reset,
    getReverseMatches,
    getLastEntry,
    resetSearch,
  } = promptHistory;
  const historyActionsRef = useRef({
    push,
    navigateUp,
    navigateDown,
    isNavigating,
    reset,
    getReverseMatches,
    getLastEntry,
    resetSearch,
  });
  historyActionsRef.current = {
    push,
    navigateUp,
    navigateDown,
    isNavigating,
    reset,
    getReverseMatches,
    getLastEntry,
    resetSearch,
  };
  const shellHistoryActionsRef = useRef(shellHistory);
  shellHistoryActionsRef.current = shellHistory;
  pastedImagesRef.current = pastedImages;

  const getSearchMatches = useCallback((query: string) => {
    const isShellMode = shellModeRef.current;
    const history = isShellMode
      ? shellHistoryActionsRef.current
      : historyActionsRef.current;
    const matches = history.getReverseMatches(query);
    return isShellMode
      ? matches
      : matches.filter((item) => !item.trimStart().startsWith('/'));
  }, []);

  const openHistorySearch = useCallback(() => {
    if (disabledRef.current) return;
    const view = viewRef.current;
    if (!view) return;
    closeSlashMenu();
    const query = view.state.doc.toString();
    searchDraftRef.current = query;
    setSearchMode(true);
    setSearchQuery('');
    const history = shellModeRef.current
      ? shellHistoryActionsRef.current
      : historyActionsRef.current;
    setSearchMatches(getSearchMatches(''));
    setSearchActiveIndex(0);
    history.resetSearch();
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [closeSlashMenu, getSearchMatches]);
  const openHistorySearchRef = useRef(openHistorySearch);
  openHistorySearchRef.current = openHistorySearch;

  const navigatePrevHistory = useCallback(() => {
    if (disabledRef.current) return;
    const view = viewRef.current;
    if (!view) return;
    if (completionStatus(view.state) === 'active') {
      moveCompletionSelection(false)(view);
      view.focus();
      return;
    }
    if (view.state.doc.lines > 1) {
      view.focus();
      return;
    }
    const history = shellModeRef.current
      ? shellHistoryActionsRef.current
      : historyActionsRef.current;
    const current = view.state.doc.toString();
    const prev = history.navigateUp(current);
    if (prev !== null) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: prev },
        selection: { anchor: prev.length },
      });
    }
    view.focus();
  }, []);

  const navigateNextHistory = useCallback(() => {
    if (disabledRef.current) return;
    const view = viewRef.current;
    if (!view) return;
    if (completionStatus(view.state) === 'active') {
      moveCompletionSelection(true)(view);
      view.focus();
      return;
    }
    if (view.state.doc.lines > 1) {
      view.focus();
      return;
    }
    const history = shellModeRef.current
      ? shellHistoryActionsRef.current
      : historyActionsRef.current;
    const next = history.navigateDown();
    if (next !== null) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        selection: { anchor: next.length },
      });
    }
    view.focus();
  }, []);

  // ---- Create CodeMirror EditorView ----
  useEffect(() => {
    if (!containerRef.current) return;

    ensureTooltipStyles();
    const tooltipPortal = document.createElement('div');
    tooltipPortal.setAttribute('data-web-shell-tooltip-portal', '');
    tooltipPortal.style.position = 'fixed';
    tooltipPortal.style.inset = '0';
    tooltipPortal.style.zIndex = 'var(--web-shell-tooltip-z-index)';
    tooltipPortal.style.pointerEvents = 'none';
    const THEME_RE = /\b\S*theme(?:Dark|Light)\S*/gi;
    const syncTheme = () => {
      let el: Element | null = containerRef.current;
      let themeClass: string | null = null;
      if (containerRef.current) {
        const computedStyle = getComputedStyle(containerRef.current);
        for (let i = 0; i < computedStyle.length; i += 1) {
          const name = computedStyle[i];
          if (name.startsWith('--')) {
            tooltipPortal.style.setProperty(
              name,
              computedStyle.getPropertyValue(name),
            );
          }
        }
        if (
          !computedStyle.getPropertyValue('--web-shell-tooltip-z-index').trim()
        ) {
          tooltipPortal.style.setProperty(
            '--web-shell-tooltip-z-index',
            '1000',
          );
        }
      }
      while (el) {
        const match = el.className?.match?.(THEME_RE);
        if (match) {
          themeClass = match[0];
          break;
        }
        el = el.parentElement;
      }
      if (themeClass) {
        tooltipPortal.className = themeClass;
      }
    };
    syncTheme();
    document.body.appendChild(tooltipPortal);

    const observer = new MutationObserver(syncTheme);
    let el: Element | null = containerRef.current;
    while (el) {
      observer.observe(el, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
      if (el.className?.match?.(THEME_RE)) break;
      el = el.parentElement;
    }

    const submitText = (
      view: EditorView,
      textOverride?: string,
      tagsOverride?: readonly WebShellComposerTag[],
    ) => {
      const rawText = (textOverride ?? view.state.doc.toString()).trim();
      const tags = tagsOverride ?? composerTagsRef.current;
      if (!rawText && tags.length === 0) return true;
      const text = expandLargePastePlaceholders(
        pendingPastesRef.current,
        rawText,
      );
      const prompt = buildComposerPrompt(text, tags);
      const images = pastedImagesRef.current;
      const isShellMode = shellModeRef.current;
      const accepted = onSubmitRef.current(
        isShellMode ? `!${prompt}` : prompt,
        images.length > 0 ? [...images] : undefined,
      );
      if (accepted === false) return true;
      setSlashMenu(null);
      onDismissFollowupRef.current?.();
      pendingPastesRef.current.clear();
      nextPasteIdRef.current = 1;
      if (isShellMode) {
        shellHistoryActionsRef.current.push(text);
        shellHistoryActionsRef.current.reset();
      } else {
        historyActionsRef.current.push(text);
        historyActionsRef.current.reset();
      }
      historyBrowseActiveRef.current = false;
      setComposerTags([]);
      setPastedImages([]);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: '' },
        effects: clearInlineTagsEffect.of(),
      });
      return true;
    };
    submitTextRef.current = submitText;

    const completionSources = [
      createAtCompletionSource(
        () => workspaceActionsRef.current?.globWorkspace,
      ),
    ];

    const insertNewline = (view: EditorView) => {
      view.dispatch(view.state.replaceSelection('\n'));
      return true;
    };

    const acceptFollowupIntoEditor = (
      view: EditorView,
      method: 'tab' | 'right',
    ): boolean => {
      const followup = followupStateRef.current;
      const suggestion = followup?.suggestion;
      const completion = getFollowupCompletion(
        view.state.doc.toString(),
        suggestion,
      );
      if (!followup?.isVisible || !completion) {
        return false;
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: completion },
        selection: { anchor: completion.length },
        scrollIntoView: true,
      });
      view.focus();
      onAcceptFollowupRef.current?.(method, { skipOnAccept: true });
      return true;
    };

    const submitKeymap = keymap.of([
      {
        key: 'Backspace',
        run: (view) => {
          const selection = view.state.selection.main;
          if (!selection.empty || selection.from !== 0) return false;
          let hasInlineTagAtStart = false;
          view.state.field(inlineComposerTagField).between(0, 1, (from) => {
            if (from === 0) hasInlineTagAtStart = true;
          });
          if (hasInlineTagAtStart) return false;
          let removableIndex = -1;
          for (let i = composerTagsRef.current.length - 1; i >= 0; i -= 1) {
            if (composerTagsRef.current[i]?.removable !== false) {
              removableIndex = i;
              break;
            }
          }
          if (removableIndex < 0) return false;
          setComposerTags((current) =>
            current.filter((_, index) => index !== removableIndex),
          );
          return true;
        },
      },
      {
        key: 'Delete',
        run: (view) => {
          const selection = view.state.selection.main;
          if (!selection.empty || selection.from !== 0) return false;
          let hasInlineTagAtStart = false;
          view.state.field(inlineComposerTagField).between(0, 1, (from) => {
            if (from === 0) hasInlineTagAtStart = true;
          });
          if (hasInlineTagAtStart) return false;
          const removableIndex = composerTagsRef.current.findIndex(
            (tag) => tag.removable !== false,
          );
          if (removableIndex < 0) return false;
          setComposerTags((current) =>
            current.filter((_, index) => index !== removableIndex),
          );
          return true;
        },
      },
      {
        key: 'Enter',
        run: (view) => {
          if (slashMenuRef.current) {
            return acceptSlashCompletion();
          }
          if (completionStatus(view.state) === 'active') return false;
          const followup = followupStateRef.current;
          const followupCompletion = getFollowupCompletion(
            view.state.doc.toString(),
            followup?.suggestion,
          );
          if (followup?.isVisible && followupCompletion) {
            onAcceptFollowupRef.current?.('enter', { skipOnAccept: true });
            return submitText(view, followupCompletion);
          }
          return submitText(view);
        },
      },
      {
        key: 'Shift-Enter',
        run: insertNewline,
      },
      {
        key: 'Ctrl-j',
        run: insertNewline,
      },
      {
        key: 'Mod-Enter',
        run: insertNewline,
      },
      {
        key: 'Alt-Enter',
        run: insertNewline,
      },
      {
        key: 'Escape',
        run: () => {
          if (slashMenuRef.current) {
            closeSlashMenu();
            return true;
          }
          if (shellModeRef.current) {
            setShellMode(false);
            return true;
          }
          if (queuedMessagesRef.current.length === 0) return false;
          return onClearQueuedMessagesRef.current?.() ?? false;
        },
      },
      {
        key: 'Ctrl-o',
        run: () => true,
      },
      {
        key: 'Ctrl-l',
        run: () => true,
      },
      {
        key: 'Ctrl-y',
        run: () => true,
      },
      {
        key: 'ArrowUp',
        run: (view) => {
          const history = shellModeRef.current
            ? shellHistoryActionsRef.current
            : historyActionsRef.current;
          const isBrowsingHistory = historyBrowseActiveRef.current;
          // Not browsing history → arrows drive the slash menu / native
          // completion. While browsing → arrows keep walking history and any
          // auto-opened menu is closed. (Gate uses historyBrowseActiveRef, not
          // the sticky history.isNavigating — see its declaration.)
          if (!isBrowsingHistory) {
            if (moveSlashCompletionSelection('up')) return true;
            if (completionStatus(view.state) === 'active') {
              return moveCompletionSelection(false)(view);
            }
          } else {
            closeCompletion(view);
            closeSlashMenu();
          }
          const multilineBoundary = handleMultilineHistoryBoundary(view, 'up');
          if (multilineBoundary === 'handled') return true;
          if (multilineBoundary === 'editor') return false;
          if (shellModeRef.current) {
            const current = view.state.doc.toString();
            const prev = history.navigateUp(current);
            if (prev === null) return true;
            historyBrowseActiveRef.current = true;
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: prev },
              selection: { anchor: prev.length },
            });
            return true;
          }
          if (queuedMessagesRef.current.length > 0) {
            const queuedText = onPopQueuedMessagesRef.current?.();
            if (queuedText) {
              const current = view.state.doc.toString();
              const next = current.trim()
                ? `${queuedText}\n${current}`
                : queuedText;
              view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: next },
                selection: { anchor: next.length },
              });
              return true;
            }
          }
          const current = view.state.doc.toString();
          const prev = history.navigateUp(current);
          if (prev === null) return false;
          historyBrowseActiveRef.current = true;
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: prev },
            selection: { anchor: prev.length },
          });
          return true;
        },
      },
      {
        key: 'ArrowDown',
        run: (view) => {
          const history = shellModeRef.current
            ? shellHistoryActionsRef.current
            : historyActionsRef.current;
          const isBrowsingHistory = historyBrowseActiveRef.current;
          // Symmetric with ArrowUp: history navigation wins while browsing;
          // the slash menu and native completion only capture arrows once the
          // user is no longer paging through history.
          if (!isBrowsingHistory) {
            if (moveSlashCompletionSelection('down')) return true;
            if (completionStatus(view.state) === 'active') {
              return moveCompletionSelection(true)(view);
            }
          } else {
            closeCompletion(view);
            closeSlashMenu();
          }
          const multilineBoundary = handleMultilineHistoryBoundary(
            view,
            'down',
          );
          if (multilineBoundary === 'handled') return true;
          if (multilineBoundary === 'editor') return false;
          if (shellModeRef.current) {
            const next = history.navigateDown();
            if (next === null) return true;
            historyBrowseActiveRef.current = history.isNavigating();
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: next },
              selection: { anchor: next.length },
            });
            return true;
          }
          const next = history.navigateDown();
          if (next === null) {
            return onFocusFooterRef.current?.() ?? false;
          }
          historyBrowseActiveRef.current = history.isNavigating();
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: next },
            selection: { anchor: next.length },
          });
          return true;
        },
      },
      {
        key: 'Ctrl-r',
        run: () => {
          openHistorySearchRef.current();
          return true;
        },
      },
      {
        key: 'Tab',
        run: (view) => {
          if (acceptFollowupIntoEditor(view, 'tab')) {
            return true;
          }
          if (slashMenuRef.current) {
            return acceptSlashCompletion();
          }
          if (completionStatus(view.state) === 'active') {
            return acceptCompletion(view);
          }
          const text = view.state.doc.toString();
          const implicitResult = getImplicitTabCompletion(
            text,
            commandsRef.current,
            languageRef.current,
          );
          if (implicitResult) {
            view.dispatch({
              changes: {
                from: 0,
                to: view.state.doc.length,
                insert: implicitResult,
              },
              selection: { anchor: implicitResult.length },
            });
            return true;
          }
          const missingSlash = getMissingSlashPrefixCompletion(
            text,
            commandsRef.current,
          );
          if (missingSlash) {
            view.dispatch({
              changes: {
                from: 0,
                to: view.state.doc.length,
                insert: missingSlash,
              },
              selection: { anchor: missingSlash.length },
            });
            return true;
          }
          return true;
        },
      },
      {
        key: 'ArrowRight',
        run: (view) => {
          if (
            completionStatus(view.state) !== 'active' &&
            acceptFollowupIntoEditor(view, 'right')
          ) {
            return true;
          }
          return false;
        },
      },
      {
        key: 'Shift-Tab',
        run: () => {
          onCycleModeRef.current?.();
          return true;
        },
      },
    ]);

    const composerUpdateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && pendingPastesRef.current.size > 0) {
        const nextPasteId = prunePendingPastes(
          pendingPastesRef.current,
          update.state.doc.toString(),
        );
        if (nextPasteId !== null) {
          nextPasteIdRef.current = nextPasteId;
        }
      }
      // A genuine edit (typing/deleting/pasting) ends history-browse mode, so
      // arrows go back to driving any open menu. Programmatic history recall
      // dispatches carry no user event, so they do not clear the flag.
      const userEdited = update.transactions.some(
        (tr) => tr.isUserEvent('input') || tr.isUserEvent('delete'),
      );
      if (userEdited) {
        historyBrowseActiveRef.current = false;
      }
      if (update.docChanged || update.selectionSet) {
        refreshSlashMenuForView(update.view);
      }
    });

    let prevCompletionActive = false;
    const triggerCleanupListener = EditorView.updateListener.of((update) => {
      const trigger = autoTriggerRef.current;
      const nowActive = completionStatus(update.state) === 'active';
      if (trigger) {
        const doc = update.state.doc;
        const intact =
          doc.length === trigger.from + trigger.text.length &&
          doc.sliceString(trigger.from) === trigger.text;
        if (!intact) {
          autoTriggerRef.current = null;
        } else if (prevCompletionActive && !nowActive) {
          autoTriggerRef.current = null;
          const { view } = update;
          const { from } = trigger;
          window.setTimeout(() => {
            if (viewRef.current !== view) return;
            const d = view.state.doc;
            if (
              d.length === from + trigger.text.length &&
              d.sliceString(from) === trigger.text
            ) {
              view.dispatch({ changes: { from, to: d.length, insert: '' } });
            }
          }, 0);
        }
      }
      prevCompletionActive = nowActive;
      if (!nowActive) {
        clearCompletionHoverInfo(tooltipPortal);
      }
    });

    const state = EditorState.create({
      doc: '',
      extensions: [
        Prec.highest(submitKeymap),
        minimalSetup,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        autocompletion({
          override: completionSources,
          activateOnTyping: true,
          icons: false,
          optionClass: (completion) =>
            completion.type === 'file'
              ? 'cm-file-completion'
              : hasCommandHoverInfo(completion)
                ? 'cm-command-info-completion'
                : '',
          addToOptions: [
            {
              render: renderCompletionHoverInfo,
              position: 90,
            },
          ],
          maxRenderedOptions: 300,
          aboveCursor: true,
          positionInfo: (_view, list, option, info, space) => {
            const infoHeight = info.bottom - info.top;
            const spaceBelow = space.bottom - list.bottom;
            const placeBelow =
              spaceBelow >= infoHeight || spaceBelow > list.top;
            const side = placeBelow ? 'top' : 'bottom';
            const offset = placeBelow
              ? option.bottom - list.top
              : list.bottom - option.top;
            return {
              style: `${side}: ${offset}px`,
              class: 'cm-completionInfo-right-narrow',
            };
          },
          activateOnCompletion: (completion) =>
            typeof completion.apply === 'string' &&
            completion.apply.endsWith(' '),
        }),
        tooltips({ parent: tooltipPortal }),
        placeholderCompartment.of(placeholder('')),
        followupGhostCompartment.of(createFollowupGhostExtension(null)),
        EditorView.lineWrapping,
        editableCompartment.of(EditorView.editable.of(true)),
        inputHighlight(
          () => commandsRef.current,
          () => languageRef.current,
        ),
        inputHighlightTheme,
        inlineComposerTagField,
        composerUpdateListener,
        triggerCleanupListener,
        // Update hasContent state when document changes
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const text = update.state.doc.toString().trim();
            setHasContent(
              text.length > 0 ||
                composerTagsRef.current.length > 0 ||
                pastedImagesRef.current.length > 0,
            );
          }
        }),
        EditorView.inputHandler.of((view, from, to, insert) => {
          if (
            insert === '!' &&
            view.state.doc.toString() === '' &&
            completionStatus(view.state) !== 'active'
          ) {
            toggleShellMode();
            return true;
          }
          if (
            insert === '?' &&
            view.state.doc.toString() === '' &&
            completionStatus(view.state) !== 'active'
          ) {
            onToggleShortcutsRef.current?.();
            return true;
          }
          return false;
        }),
        EditorView.domEventHandlers({
          blur() {
            closeSlashMenu();
            return false;
          },
          paste(event) {
            const items = event.clipboardData?.items;
            if (!items) return false;
            let hasImage = false;
            for (const item of items) {
              if (
                item.type.startsWith('image/') &&
                /^image\/(png|jpeg|gif|webp)$/i.test(item.type)
              ) {
                hasImage = true;
                const file = item.getAsFile();
                if (!file) continue;
                const mediaType = item.type;
                const reader = new FileReader();
                reader.onload = () => {
                  const base64 = (reader.result as string).split(',')[1];
                  setPastedImages((prev) => [
                    ...prev,
                    { data: base64, media_type: mediaType },
                  ]);
                };
                reader.readAsDataURL(file);
              }
            }
            if (hasImage) {
              event.preventDefault();
              return true;
            }
            const pasted = normalizePastedText(
              event.clipboardData?.getData('text/plain') ?? '',
            );
            if (!pasted || !isLargePaste(pasted)) return false;

            event.preventDefault();
            if (
              view.state.doc.toString() === '' &&
              followupStateRef.current?.isVisible
            ) {
              onDismissFollowupRef.current?.();
            }
            const { placeholderText: pt, nextPasteId } =
              createLargePastePlaceholder(
                pendingPastesRef.current,
                nextPasteIdRef.current,
                pasted,
              );
            nextPasteIdRef.current = nextPasteId;
            const selection = view.state.selection.main;
            view.dispatch({
              changes: {
                from: selection.from,
                to: selection.to,
                insert: pt,
              },
              selection: { anchor: selection.from + pt.length },
              scrollIntoView: true,
            });
            return true;
          },
        }),
        EditorView.theme(editorTheme),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;
    view.focus();

    // Initial check
    const initialText = view.state.doc.toString().trim();
    setHasContent(
      initialText.length > 0 ||
        composerTagsRef.current.length > 0 ||
        pastedImagesRef.current.length > 0,
    );

    return () => {
      view.destroy();
      viewRef.current = null;
      observer.disconnect();
      tooltipPortal.remove();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Reactions to prop changes ----

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.reconfigure(
        EditorView.editable.of(!disabled),
      ),
    });
    if (!disabled) {
      view.focus();
    }
  }, [disabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const followupSuggestion =
      !disabled && followupState?.isVisible && followupState.suggestion
        ? followupState.suggestion
        : null;
    const nextPlaceholder =
      followupSuggestion ??
      (shellMode ? t('editor.shellPlaceholder') : placeholderText);
    view.dispatch({
      effects: [
        placeholderCompartment.reconfigure(placeholder(nextPlaceholder)),
        followupGhostCompartment.reconfigure(
          createFollowupGhostExtension(followupSuggestion),
        ),
      ],
    });
  }, [
    disabled,
    placeholderText,
    shellMode,
    t,
    followupState?.isVisible,
    followupState?.suggestion,
  ]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || completionStatus(view.state) !== 'active') return;
    closeCompletion(view);
    window.setTimeout(() => {
      if (viewRef.current === view) {
        startCompletion(view);
      }
    }, 0);
  }, [language]);

  const slashMenuDataKey = [
    commands
      .map((command) =>
        [
          command.name,
          command.description ?? '',
          command.source ?? '',
          command.displayCategory ?? '',
          command.argumentHint ?? '',
          command.subcommands?.join(',') ?? '',
        ].join('\u0000'),
      )
      .join('\u0001'),
    skills
      .map((skill) => [skill.name, skill.description].join('\u0000'))
      .join('\u0001'),
    slashCommandCategoryOrder?.join('|') ?? '',
  ].join('\u0002');

  useEffect(() => {
    if (slashMenuRef.current) {
      refreshSlashMenuForView(viewRef.current);
    }
  }, [slashMenuDataKey, language, refreshSlashMenuForView]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (dialogOpen) {
      closeSlashMenu();
      view.contentDOM.blur();
    } else {
      view.focus();
    }
  }, [dialogOpen, closeSlashMenu]);

  // Global keydown handler for focus-stealing
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (disabledRef.current || searchMode || dialogOpen) return;
      if (event.defaultPrevented) return;
      // Only capture keystrokes if the target is within the web-shell container
      // or if no specific element has focus (document.body is active)
      const target = event.target as Node;
      const isWithinContainer = containerRef.current?.contains(target);
      const isBodyFocused = document.activeElement === document.body;
      if (!isWithinContainer && !isBodyFocused) return;
      const view = viewRef.current;
      const followup = followupStateRef.current;
      const followupCompletion = getFollowupCompletion(
        view?.state.doc.toString() ?? '',
        followup?.suggestion,
      );
      if (
        view &&
        !view.hasFocus &&
        followup?.isVisible &&
        followupCompletion &&
        !isEditableTarget(event.target)
      ) {
        if (
          event.key === 'Tab' &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          completionStatus(view.state) !== 'active'
        ) {
          event.preventDefault();
          view.dispatch({
            changes: {
              from: 0,
              to: view.state.doc.length,
              insert: followupCompletion,
            },
            selection: { anchor: followupCompletion.length },
            scrollIntoView: true,
          });
          view.focus();
          onAcceptFollowupRef.current?.('tab', { skipOnAccept: true });
          return;
        }
        if (
          event.key === 'ArrowRight' &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          completionStatus(view.state) !== 'active'
        ) {
          event.preventDefault();
          view.dispatch({
            changes: {
              from: 0,
              to: view.state.doc.length,
              insert: followupCompletion,
            },
            selection: { anchor: followupCompletion.length },
            scrollIntoView: true,
          });
          view.focus();
          onAcceptFollowupRef.current?.('right', { skipOnAccept: true });
          return;
        }
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1) return;
      if (isEditableTarget(event.target)) return;

      if (!view || view.hasFocus) return;

      event.preventDefault();
      if (event.key === '!' && view.state.doc.toString() === '') {
        toggleShellMode();
        return;
      }
      const selection = view.state.selection.main;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: event.key },
        selection: { anchor: selection.from + event.key.length },
        scrollIntoView: true,
      });
      view.focus();
      if (event.key === '/') {
        window.setTimeout(() => {
          refreshSlashMenuForView(viewRef.current);
        }, 0);
      } else if (event.key === '@') {
        window.setTimeout(() => {
          const nextView = viewRef.current;
          if (nextView && nextView.hasFocus) {
            startCompletion(nextView);
          }
        }, 0);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchMode, dialogOpen, refreshSlashMenuForView, toggleShellMode]);

  // ---- Imperative methods ----

  const focus = useCallback(() => {
    viewRef.current?.focus();
  }, []);

  const insertText = useCallback(
    (text: string, options?: WebShellComposerTextOptions) => {
      const view = viewRef.current;
      if (!view || !text) {
        view?.focus();
        return;
      }
      if (options?.mode === 'replace') {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          effects: clearInlineTagsEffect.of(),
          selection: { anchor: text.length },
          scrollIntoView: true,
        });
        view.focus();
        return;
      }
      const selection = view.state.selection.main;
      let insert = text;
      let skipInsert = false;
      let caretOverride: number | null = null;
      const openAtMenu = text === '@';
      let openSlashMenu = text === '/';
      if (text === '/') {
        const line = view.state.doc.lineAt(selection.head);
        if (line.text.startsWith('/')) {
          skipInsert = true;
        } else if (view.state.doc.length > 0) {
          skipInsert = true;
          openSlashMenu = false;
        }
      } else if (text === '@') {
        const before =
          selection.from > 0
            ? view.state.doc.sliceString(selection.from - 1, selection.from)
            : '';
        const after = view.state.doc.sliceString(
          selection.from,
          selection.from + 1,
        );
        if (after === '@') {
          skipInsert = true;
          caretOverride = selection.from + 1;
        } else if (before === '@') {
          skipInsert = true;
        } else if (before && !/\s/.test(before)) {
          insert = ' @';
        }
      }
      if (!skipInsert) {
        view.dispatch({
          changes: { from: selection.from, to: selection.to, insert },
          selection: { anchor: selection.from + insert.length },
          scrollIntoView: true,
        });
        if (openAtMenu) {
          autoTriggerRef.current = { text: insert, from: selection.from };
        }
      } else if (caretOverride !== null) {
        view.dispatch({
          selection: { anchor: caretOverride },
          scrollIntoView: true,
        });
      }
      view.focus();
      if (openSlashMenu) {
        window.setTimeout(() => {
          refreshSlashMenuForView(viewRef.current);
        }, 0);
      } else if (openAtMenu) {
        window.setTimeout(() => {
          const nextView = viewRef.current;
          if (nextView && nextView.hasFocus) {
            startCompletion(nextView);
          }
        }, 0);
      }
    },
    [refreshSlashMenuForView],
  );

  const getText = useCallback(() => {
    return viewRef.current?.state.doc.toString() ?? '';
  }, []);

  const setText = useCallback((text: string) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      effects: clearInlineTagsEffect.of(),
      selection: { anchor: text.length },
      scrollIntoView: true,
    });
    view.focus();
  }, []);

  const removeInlineTags = useCallback(
    (predicate?: (tag: WebShellComposerTag) => boolean) => {
      const view = viewRef.current;
      if (!view) return;
      const changes: Array<{ from: number; to: number; insert: string }> = [];
      view.state
        .field(inlineComposerTagField)
        .between(0, view.state.doc.length, (from, to, value) => {
          const tag = (value.spec as Partial<InlineTagDecorationSpec>).tag;
          if (tag && (!predicate || predicate(tag))) {
            changes.push({ from, to, insert: '' });
          }
        });
      view.dispatch({
        ...(changes.length > 0 ? { changes } : {}),
        effects: removeInlineTagEffect.of({ predicate }),
        scrollIntoView: true,
      });
    },
    [],
  );

  const clear = useCallback(
    (options?: { text?: boolean; tags?: boolean }) => {
      const clearTextOpt = options?.text ?? true;
      const clearTags = options?.tags ?? true;
      const view = viewRef.current;
      if (clearTextOpt && view && view.state.doc.length > 0) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: '' },
          effects: clearInlineTagsEffect.of(),
        });
      }
      if (clearTextOpt) {
        setPastedImages([]);
        pendingPastesRef.current.clear();
        nextPasteIdRef.current = 1;
      }
      if (clearTags) {
        setComposerTags([]);
        if (!clearTextOpt) {
          removeInlineTags();
        }
      }
    },
    [removeInlineTags],
  );

  const clearText = useCallback(() => {
    clear({ text: true, tags: false });
  }, [clear]);

  const addTags = useCallback(
    (
      tags: readonly WebShellComposerTag[],
      tagOptions?: WebShellComposerTagOptions,
    ) => {
      if (tags.length === 0) return;
      if (tagOptions?.placement === 'inline') {
        const view = viewRef.current;
        if (!view) return;
        const selection = view.state.selection.main;
        let at = selection.from;
        const ranges: InlineTagRange[] = [];
        const insert = tags
          .map((tag) => {
            const tagText = serializeComposerTag(tag);
            ranges.push({ from: at, to: at + tagText.length, tag });
            at += tagText.length + 1;
            return tagText;
          })
          .join(' ');
        const text = insert ? `${insert} ` : '';
        view.dispatch({
          changes: { from: selection.from, to: selection.to, insert: text },
          effects:
            ranges.length > 0
              ? ranges.map((range) => addInlineTagEffect.of(range))
              : undefined,
          selection: { anchor: selection.from + text.length },
          scrollIntoView: true,
        });
        view.focus();
        return;
      }
      setComposerTags((current) => {
        const next = [...current];
        for (const tag of tags) {
          const existingIndex = next.findIndex((item) => item.id === tag.id);
          if (existingIndex >= 0) {
            next[existingIndex] = tag;
          } else {
            next.push(tag);
          }
        }
        return next;
      });
    },
    [],
  );

  const removeTopTag = useCallback(
    (id: string) => {
      setComposerTags((current) =>
        current.filter((tag) => tag.id !== id || tag.removable === false),
      );
      removeInlineTags((tag) => tag.id === id && tag.removable !== false);
    },
    [removeInlineTags],
  );

  const hasInput = useCallback(() => {
    return (
      (viewRef.current?.state.doc.toString().trim().length ?? 0) > 0 ||
      composerTagsRef.current.length > 0 ||
      pastedImagesRef.current.length > 0
    );
  }, []);

  const submit = useCallback((input?: WebShellComposerInput) => {
    const view = viewRef.current;
    if (!view) return;
    const inlineTags = getInlineComposerTags(view);
    if (input?.tagPlacement === 'inline') {
      submitTextRef.current(
        view,
        buildComposerPrompt(input.text ?? '', input.tags ?? inlineTags),
        [],
      );
      return;
    }
    if (
      input?.text !== undefined &&
      input.tags === undefined &&
      inlineTags.length > 0
    ) {
      submitTextRef.current(
        view,
        buildComposerPrompt(input.text, inlineTags),
        [],
      );
      return;
    }
    submitTextRef.current(
      view,
      input?.text,
      input ? (input.tags ?? []) : undefined,
    );
  }, []);

  const retryLast = useCallback(() => {
    const last = historyActionsRef.current.getLastEntry(
      (e) => !e.startsWith('/') && !e.startsWith('!'),
    );
    if (!last) return;
    const accepted = onSubmitRef.current(last);
    if (accepted === false) return;
    setPastedImages([]);
  }, []);

  const replaceEditorText = useCallback((text: string) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
      scrollIntoView: true,
    });
  }, []);

  // ---- composerInput sync ----

  useEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;
    const view = viewRef.current;
    if (!view) return;

    const tagPlacement = input.tagPlacement ?? 'top';
    if (input.tags !== undefined && tagPlacement === 'top') {
      setComposerTags([...input.tags]);
    }
    if (input.text !== undefined || tagPlacement === 'inline') {
      const inlineTags =
        tagPlacement === 'inline' ? [...(input.tags ?? [])] : [];
      const inlineText = inlineTags.map(serializeComposerTag).join(' ');
      const nextText =
        tagPlacement === 'inline'
          ? inlineText && input.text
            ? `${inlineText} ${input.text}`
            : inlineText || (input.text ?? '')
          : (input.text ?? '');
      const effects: StateEffect<unknown>[] = [clearInlineTagsEffect.of()];
      if (inlineTags.length > 0) {
        let from = 0;
        for (const tag of inlineTags) {
          const tagText = serializeComposerTag(tag);
          effects.push(
            addInlineTagEffect.of({
              from,
              to: from + tagText.length,
              tag,
            }),
          );
          from += tagText.length + 1;
        }
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: nextText },
        effects,
        selection: { anchor: nextText.length },
        scrollIntoView: true,
      });
    } else {
      view.dispatch({ effects: clearInlineTagsEffect.of() });
    }
    if (input.text !== undefined || input.submit) {
      view.focus();
    }
    let submitTimer: number | null = null;
    if (input.submit) {
      submitTimer = window.setTimeout(() => {
        const nextView = viewRef.current;
        if (!nextView) return;
        submit(input);
      }, 0);
    }
    return () => {
      if (submitTimer !== null) {
        window.clearTimeout(submitTimer);
      }
    };
  }, [composerInputVersion, submit]);

  // ---- Search state ----

  const closeSearch = useCallback(
    (restoreDraft: boolean, keepFocus = true) => {
      if (restoreDraft) {
        replaceEditorText(searchDraftRef.current);
      }
      setSearchMode(false);
      setSearchQuery('');
      setSearchMatches([]);
      setSearchActiveIndex(0);
      const history = shellModeRef.current
        ? shellHistoryActionsRef.current
        : historyActionsRef.current;
      history.resetSearch();
      if (keepFocus) {
        viewRef.current?.focus();
      }
    },
    [replaceEditorText],
  );

  useEffect(() => {
    if (!searchMode) return;
    const onPointerOutside = (event: Event) => {
      if (event instanceof MouseEvent && event.button !== 0) return;
      if (event.defaultPrevented) return;
      const panel = searchUiRef.current;
      const target = event.target;
      if (panel && target instanceof Node && !panel.contains(target)) {
        closeSearch(true, false);
      }
    };
    window.addEventListener('mousedown', onPointerOutside);
    window.addEventListener('touchstart', onPointerOutside);
    return () => {
      window.removeEventListener('mousedown', onPointerOutside);
      window.removeEventListener('touchstart', onPointerOutside);
    };
  }, [searchMode, closeSearch]);

  const submitSearchMatch = useCallback(
    (match: string) => {
      const view = viewRef.current;
      if (!view) return;
      closeSearch(false);
      const text = match.trim();
      if (!text) return;
      const images = pastedImagesRef.current;
      const isShellMode = shellModeRef.current;
      const accepted = onSubmitRef.current(
        isShellMode ? `!${text}` : text,
        images.length > 0 ? [...images] : undefined,
      );
      if (accepted === false) {
        replaceEditorText(match);
        return;
      }
      onDismissFollowupRef.current?.();
      if (isShellMode) {
        shellHistoryActionsRef.current.push(text);
        shellHistoryActionsRef.current.reset();
      } else {
        historyActionsRef.current.push(text);
        historyActionsRef.current.reset();
      }
      setPastedImages([]);
      replaceEditorText('');
    },
    [closeSearch, replaceEditorText],
  );

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // While an IME is composing, keys belong to the IME. For example, Enter
    // commits the candidate instead of submitting the history search.
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch(true);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const match = searchMatches[searchActiveIndex];
      if (match) {
        replaceEditorText(match);
      }
      closeSearch(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const match = searchMatches[searchActiveIndex];
      if (match) {
        submitSearchMatch(match);
      } else {
        closeSearch(false);
      }
    } else if (e.key === 'r' && e.ctrlKey) {
      e.preventDefault();
      if (searchMatches.length > 0) {
        setSearchActiveIndex((index) => (index + 1) % searchMatches.length);
      }
    }
  };

  const runHistorySearch = (q: string) => {
    const history = shellModeRef.current
      ? shellHistoryActionsRef.current
      : historyActionsRef.current;
    setSearchMatches(getSearchMatches(q));
    setSearchActiveIndex(0);
    history.resetSearch();
  };

  const handleSearchInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setSearchQuery(q);
    if ((e.nativeEvent as InputEvent).isComposing) return;
    runHistorySearch(q);
  };

  const handleSearchCompositionEnd = (
    e: React.CompositionEvent<HTMLInputElement>,
  ) => {
    const q = e.currentTarget.value;
    setSearchQuery(q);
    runHistorySearch(q);
  };

  const removeImage = useCallback((index: number) => {
    setPastedImages((prev) => prev.filter((_, idx) => idx !== index));
  }, []);

  // ---- Computed ----

  const showShortcutHints =
    !shellMode &&
    !searchMode &&
    !followupState?.isVisible &&
    !disabled &&
    !dialogOpen;

  // ---- Imperative handle ----

  const handle: EditorHandle = {
    clearText,
    clear,
    focus,
    getText,
    hasInput,
    setText,
    addTags,
    removeTag: removeTopTag,
    insertText,
    retryLast,
    submit,
  };

  return {
    containerRef,
    viewRef,
    focus,
    submitText: useCallback(() => {
      const view = viewRef.current;
      if (!view) return;
      submitTextRef.current(view);
    }, []),
    clearText,
    getText,
    hasInput,
    hasContent,
    handle,
    pastedImages,
    removeImage,
    composerTags,
    removeTopTag,
    addTags,
    removeInlineTags,
    insertText,
    setText,
    submit,
    clear,
    retryLast,
    replaceEditorText,
    shellMode,
    setShellMode,
    toggleShellMode,
    currentMode,
    sessionName,
    searchState: {
      searchMode,
      searchQuery,
      searchMatches,
      searchActiveIndex,
      searchInputRef,
      searchUiRef,
      openHistorySearch,
      closeSearch,
      submitSearchMatch,
      handleSearchKeyDown,
      handleSearchInput,
      handleSearchCompositionEnd,
    },
    navigatePrevHistory,
    navigateNextHistory,
    showShortcutHints,
    followupState:
      followupState as UseDaemonFollowupSuggestionReturn['followupState'],
    disabled,
    onAcceptFollowup:
      onAcceptFollowup as UseDaemonFollowupSuggestionReturn['onAcceptFollowup'],
    onDismissFollowup:
      onDismissFollowup as UseDaemonFollowupSuggestionReturn['onDismissFollowup'],
    slashMenu,
    closeSlashMenu,
    selectSlashCompletion,
    acceptSlashCompletion,
  };
}
