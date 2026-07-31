import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { coerceInputText } from '@/lib/input-text';
import { cn } from '@/lib/utils';
import {
  findMentionMatches,
  parseMentions,
  type MentionMatch,
} from '@/lib/mentions';
import {
  findSlashCommandMatches,
  type SlashCommandMatch,
} from '@/lib/slash-command-badges';
import {
  loadSourceIcon,
  loadSkillIcon,
  getSourceIconSync,
  getSkillIconSync,
  EMOJI_ICON_PREFIX,
} from '@/lib/icon-cache';
import type { LoadedSkill, LoadedSource } from '../../../shared/types';
import type { MentionItemType } from './mention-menu';

type InlineBadgeType = MentionItemType | 'command';
type InlineBadgeMatch = MentionMatch | SlashCommandMatch;

// ============================================================================
// Types
// ============================================================================

/** Line count threshold for auto-converting pasted text to file attachment */
const LONG_TEXT_LINE_THRESHOLD = 100;

export interface EscapeCompositionEventLike {
  key?: string;
  isComposing?: boolean;
  nativeEvent?: {
    isComposing?: boolean;
  };
}

/**
 * Returns true when Escape is pressed while IME composition is active.
 *
 * Uses both local composition state and event-level composing flags for
 * browser/runtime compatibility.
 */
export function isEscapeDuringComposition(
  event: EscapeCompositionEventLike,
  isComposingRefActive: boolean,
): boolean {
  if (event.key !== 'Escape') return false;
  return Boolean(
    isComposingRefActive || event.isComposing || event.nativeEvent?.isComposing,
  );
}

export interface RichTextInputProps
  extends Omit<
    React.HTMLAttributes<HTMLDivElement>,
    'onChange' | 'onInput' | 'onPaste'
  > {
  /** Current text value */
  value: string;
  /** Called when text changes */
  onChange: (value: string) => void;
  /** Placeholder text(s) when empty - can be a single string or array for rotation */
  placeholder?: string | string[];
  /** Available skills for mention parsing */
  skills?: LoadedSkill[];
  /** Available sources for mention parsing */
  sources?: LoadedSource[];
  /** Workspace ID for avatars */
  workspaceId?: string;
  /** Slash command names that should render as inline command badges */
  slashCommandNames?: string[];
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Called when input changes (provides value and cursor position for mention detection) */
  onInput?: (value: string, cursorPosition: number) => void;
  /** Called on paste */
  onPaste?: (e: React.ClipboardEvent) => void;
  /** Called when pasted text exceeds line threshold - should create file attachment */
  onLongTextPaste?: (text: string) => void;
}

export interface RichTextInputHandle {
  focus: () => void;
  blur: () => void;
  /** The text value */
  value: string;
  /** Selection start position in text model */
  selectionStart: number;
  /** Set the text value */
  setValue: (value: string) => void;
  /** Set selection range */
  setSelectionRange: (start: number, end: number) => void;
  /** Get bounding rect for position calculations */
  getBoundingClientRect: () => DOMRect;
  /** Get bounding rect of the current caret/selection position */
  getCaretRect: () => DOMRect | null;
  /** The underlying div element */
  element: HTMLDivElement | null;
}

// ============================================================================
// InlineMentionBadge - Compact badge for inline display (static HTML version)
// ============================================================================

// SVG icons as HTML strings (avoiding react-dom/server which doesn't work in browser)
const SKILL_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`;

const SOURCE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`;

const COMMAND_ICON_HTML = `<span class="h-[12px] w-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0 text-[10px] font-medium">/</span>`;

// File icon (document with folded corner) - matches UserMessageBubble style (12x12, text-muted-foreground)
const FILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M9 16H15M9 12H10M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/></svg>`;

// Code file icon (document with < > brackets) - matches UserMessageBubble style (12x12, text-muted-foreground)
const CODE_FILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M10.5 12.8799C9.70024 13.2985 9.10807 13.8275 8.64232 14.5478C8.51063 14.7515 8.44479 14.8533 8.44489 15.0011C8.44498 15.1488 8.51099 15.2506 8.643 15.4542C9.1095 16.1736 9.70167 16.7028 10.5 17.1225M13.5 12.8799C14.2998 13.2985 14.8919 13.8275 15.3577 14.5478C15.4894 14.7515 15.5552 14.8533 15.5551 15.0011C15.555 15.1488 15.489 15.2506 15.357 15.4542C14.8905 16.1736 14.2983 16.7028 13.5 17.1225M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/></svg>`;

// Folder icon (open folder) - matches UserMessageBubble style (12x12, text-muted-foreground)
const FOLDER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M20.5 10C20.5 9.07003 20.5 8.60504 20.3978 8.22354C20.1204 7.18827 19.3117 6.37962 18.2765 6.10222C17.895 6 17.43 6 16.5 6H13.1008C12.4742 6 12.1609 6 11.8739 5.91181C11.6824 5.85298 11.5009 5.76572 11.3353 5.65295C11.0871 5.48389 10.8914 5.23926 10.5 4.75L10.4095 4.63693C10.107 4.25881 9.9558 4.06975 9.7736 3.92674C9.54464 3.74703 9.27921 3.61946 8.99585 3.55294C8.77037 3.5 8.52825 3.5 8.04402 3.5C6.60485 3.5 5.88527 3.5 5.32008 3.74178C4.61056 4.0453 4.0453 4.61056 3.74178 5.32008C3.5 5.88527 3.5 6.60485 3.5 8.04402V10M9.46502 20.5H14.535C16.9102 20.5 18.0978 20.5 18.9301 19.8113C19.7624 19.1226 19.9846 17.9559 20.429 15.6227L20.8217 13.5613C21.1358 11.9121 21.2929 11.0874 20.843 10.5437C20.393 10 19.5536 10 17.8746 10H6.12537C4.44643 10 3.60696 10 3.15704 10.5437C2.70713 11.0874 2.8642 11.9121 3.17835 13.5613L3.57099 15.6227C4.01541 17.9559 4.23763 19.1226 5.06992 19.8113C5.90221 20.5 7.08981 20.5 9.46502 20.5Z"/></svg>`;

/** Known code file extensions - used to pick code file icon vs generic file icon */
const CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rs',
  'go',
  'java',
  'rb',
  'swift',
  'kt',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'css',
  'scss',
  'less',
  'html',
  'vue',
  'svelte',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'sh',
  'bash',
  'zsh',
  'fish',
  'md',
  'mdx',
  'sql',
  'graphql',
  'proto',
]);

function isCodeFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext ? CODE_EXTENSIONS.has(ext) : false;
}

function renderBadgeHTML(
  type: InlineBadgeType,
  label: string,
  skill?: LoadedSkill,
  source?: LoadedSource,
  workspaceId?: string,
  tooltip?: string,
): string {
  // Try to get cached icon first
  let iconHtml = '';
  let cachedIconUrl: string | null = null;

  if (type === 'skill' && skill && workspaceId) {
    cachedIconUrl = getSkillIconSync(workspaceId, skill.slug);
  } else if (type === 'source' && source && workspaceId) {
    cachedIconUrl = getSourceIconSync(workspaceId, source.config.slug);
  }

  if (cachedIconUrl) {
    // Check for emoji marker - render as text, not image
    if (cachedIconUrl.startsWith(EMOJI_ICON_PREFIX)) {
      const emoji = cachedIconUrl.slice(EMOJI_ICON_PREFIX.length);
      iconHtml = `<span class="h-[12px] w-[12px] flex items-center justify-center text-[10px] leading-none shrink-0">${emoji}</span>`;
    } else {
      // Use cached icon as img (data URL or external URL)
      iconHtml = `<img src="${cachedIconUrl}" class="h-[12px] w-[12px] rounded-[2px] shrink-0" alt="" />`;
    }
  } else {
    // Fall back to generic SVG icon based on type
    if (type === 'skill') {
      iconHtml = `<span class="h-[12px] w-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0">${SKILL_ICON_SVG}</span>`;
    } else if (type === 'source') {
      iconHtml = `<span class="h-[12px] w-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0">${SOURCE_ICON_SVG}</span>`;
    } else if (type === 'file') {
      // Pick code file or generic file icon based on extension (no container, icon carries its own classes)
      iconHtml = isCodeFile(label) ? CODE_FILE_ICON_SVG : FILE_ICON_SVG;
    } else if (type === 'folder') {
      iconHtml = FOLDER_ICON_SVG;
    } else if (type === 'command') {
      iconHtml = COMMAND_ICON_HTML;
    }
  }

  const escapedLabel = label.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const titleAttr = tooltip
    ? ` title="${tooltip.replace(/"/g, '&quot;')}"`
    : '';

  // Line height is increased when badges are present (see hasMentions in component)
  // Use transform for upward shift - doesn't affect layout flow (works even at start of line)
  return `<span contenteditable="false" data-mention="true"${titleAttr} class="mention-badge inline-flex items-center gap-1 h-[22px] px-1.5 mx-1 rounded-[5px] bg-background shadow-minimal text-[12px] text-foreground select-none [&_*]:selection:bg-transparent selection:bg-transparent" style="vertical-align: middle; transform: translateY(-1px)">${iconHtml}<span class="truncate max-w-[200px]">${escapedLabel}</span></span>`;
}

// ============================================================================
// Helper: Extract plain text from contenteditable
// ============================================================================

function getTextFromElement(element: HTMLElement): string {
  let text = '';

  const meaningfulChildren = Array.from(element.childNodes).filter((node) => {
    if (node.nodeType !== Node.TEXT_NODE) return true;
    return (node.textContent || '').replace(/\u200B/g, '') !== '';
  });
  const onlyMeaningfulChild = meaningfulChildren[0];
  if (
    meaningfulChildren.length === 1 &&
    (onlyMeaningfulChild as HTMLElement | undefined)?.tagName === 'BR'
  ) {
    return '';
  }

  // isTopLevel: true for direct children of the contenteditable root
  function processNode(node: Node, isTopLevel: boolean = false) {
    if (node.nodeType === Node.TEXT_NODE) {
      // Filter out zero-width spaces (used for contenteditable cursor fix)
      text += (node.textContent || '').replace(/\u200B/g, '');
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;

      // Skip mention badges - they shouldn't contribute additional text
      if (el.getAttribute('data-mention') === 'true') {
        // Get the mention text from data attribute
        const mentionText = el.getAttribute('data-mention-text');
        if (mentionText) {
          text += mentionText;
        }
        return; // Don't process children
      }

      // Handle line breaks
      if (el.tagName === 'BR') {
        text += '\n';
      } else if (
        el.tagName === 'DIV' &&
        text.length > 0 &&
        !text.endsWith('\n')
      ) {
        // DIVs in contenteditable normally represent line breaks.
        // HOWEVER: When typing before a badge at position 0, browsers wrap the
        // typed character in a <div>, creating: <div>typed</div><span badge>
        // This is NOT a user-intended line break - it's browser behavior.
        // We detect this by checking if a top-level DIV is immediately followed
        // by a mention badge sibling. If so, skip adding the newline.
        if (isTopLevel) {
          // Check if this DIV is followed by a mention badge at top level.
          // Skip over ZWS-only text nodes - browser may preserve them between
          // the DIV wrapper and the badge span.
          let nextSibling: Node | null = el.nextSibling;
          while (
            nextSibling?.nodeType === Node.TEXT_NODE &&
            nextSibling.textContent?.replace(/\u200B/g, '') === ''
          ) {
            nextSibling = nextSibling.nextSibling;
          }
          const isBrowserWrapper =
            (nextSibling as HTMLElement)?.getAttribute?.('data-mention') ===
            'true';
          if (!isBrowserWrapper) {
            text += '\n';
          }
          // If it IS followed by a badge, don't add newline - just process children
        } else {
          // Nested DIVs are always treated as line breaks
          text += '\n';
        }
      }

      // Process children (no longer top-level)
      Array.from(el.childNodes).forEach((child) => {
        processNode(child, false);
      });
    }
  }

  // Process direct children as top-level nodes
  Array.from(element.childNodes).forEach((child) => {
    processNode(child, true);
  });

  return text;
}

// ============================================================================
// Helper: Get cursor position in text model
// ============================================================================

function getCursorPosition(element: HTMLElement, fallback: number = 0): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return fallback;

  const range = selection.getRangeAt(0);

  // Create a range from start of element to cursor
  const preRange = document.createRange();
  preRange.selectNodeContents(element);
  preRange.setEnd(range.startContainer, range.startOffset);

  // Get text length before cursor, excluding badge content
  const fragment = preRange.cloneContents();
  const div = document.createElement('div');
  div.appendChild(fragment);
  return getTextFromElement(div).length;
}

// ============================================================================
// Helper: Set cursor position in contenteditable
// ============================================================================

function setCursorPosition(element: HTMLElement, targetPosition: number): void {
  const selection = window.getSelection();
  if (!selection) return;

  let currentPos = 0;

  function findPosition(node: Node): { node: Node; offset: number } | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const rawText = node.textContent || '';
      // Filter out zero-width spaces to match text model (ZWS is a DOM-only artifact)
      const textWithoutZWS = rawText.replace(/\u200B/g, '');
      const modelLength = textWithoutZWS.length;

      if (currentPos + modelLength >= targetPosition) {
        // Calculate actual DOM offset accounting for zero-width spaces
        const modelOffset = targetPosition - currentPos;
        let domOffset = 0;
        let modelCount = 0;
        while (modelCount < modelOffset && domOffset < rawText.length) {
          if (rawText[domOffset] !== '\u200B') {
            modelCount++;
          }
          domOffset++;
        }
        // Skip any trailing ZWS at the target position
        while (domOffset < rawText.length && rawText[domOffset] === '\u200B') {
          domOffset++;
        }
        return { node, offset: domOffset };
      }
      currentPos += modelLength;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;

      // Skip mention badge internals - treat as atomic
      if (el.getAttribute('data-mention') === 'true') {
        const mentionText = el.getAttribute('data-mention-text') || '';
        const mentionLength = mentionText.length;
        if (currentPos + mentionLength >= targetPosition) {
          // Position cursor after the badge
          return {
            node: el.parentNode!,
            offset: Array.from(el.parentNode!.childNodes).indexOf(el) + 1,
          };
        }
        currentPos += mentionLength;
        return null;
      }

      // Handle BR
      if (el.tagName === 'BR') {
        currentPos += 1;
        if (currentPos >= targetPosition) {
          return {
            node: el.parentNode!,
            offset: Array.from(el.parentNode!.childNodes).indexOf(el) + 1,
          };
        }
        return null;
      }

      for (let i = 0; i < el.childNodes.length; i++) {
        const result = findPosition(el.childNodes[i]);
        if (result) return result;
      }
    }
    return null;
  }

  const result = findPosition(element);

  if (result) {
    const range = document.createRange();
    range.setStart(result.node, result.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    // Position at end
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

// ============================================================================
// Convert text with mentions to HTML
// ============================================================================

function textToHTML(
  text: string,
  skills: LoadedSkill[],
  sources: LoadedSource[],
  workspaceId?: string,
  slashCommandNames: string[] = [],
): string {
  if (!text) return '';

  const skillSlugs = skills.map((s) => s.slug);
  const sourceSlugs = sources.map((s) => s.config.slug);
  const matches: InlineBadgeMatch[] = [
    ...findMentionMatches(text, skillSlugs, sourceSlugs),
    ...findSlashCommandMatches(text, slashCommandNames),
  ].sort((a, b) => a.startIndex - b.startIndex);

  // Escape HTML in text
  const escapeHTML = (str: string) =>
    str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');

  if (matches.length === 0) {
    return escapeHTML(text);
  }

  let html = '';
  let lastIndex = 0;

  // If first match starts at position 0, prepend zero-width space for contenteditable cursor fix
  if (matches[0].startIndex === 0) {
    html += '\u200B';
  }

  for (const match of matches) {
    // Add escaped text before this mention
    if (match.startIndex > lastIndex) {
      html += escapeHTML(text.slice(lastIndex, match.startIndex));
    }

    // Determine label and data for badge
    let label = match.id;
    let skill: LoadedSkill | undefined;
    let source: LoadedSource | undefined;
    let tooltip: string | undefined;

    if (match.type === 'command') {
      label = match.fullMatch.replace(/^\/+/, '');
      tooltip = 'Slash command';
    } else if (match.type === 'skill') {
      skill = skills.find((s) => s.slug === match.id);
      label = skill?.metadata.name || match.id;
    } else if (match.type === 'source') {
      source = sources.find((s) => s.config.slug === match.id);
      label = source?.config.name || match.id;
    } else if (match.type === 'file') {
      // Show filename as badge label, full path as tooltip
      label = match.id.split('/').pop() || match.id;
      tooltip = match.id;
    } else if (match.type === 'folder') {
      // Show folder name as badge label, full path as tooltip
      label = match.id.split('/').pop() || match.id;
      tooltip = match.id;
    }

    // Render badge with data-mention-text storing the original text
    const badgeHtml = renderBadgeHTML(
      match.type,
      label,
      skill,
      source,
      workspaceId,
      tooltip,
    );
    // Add data-mention-text attribute to store original text for extraction
    const withMentionText = badgeHtml.replace(
      'data-mention="true"',
      `data-mention="true" data-mention-text="${match.fullMatch.replace(/"/g, '&quot;')}"`,
    );
    html += withMentionText;
    // Zero-width space after badge ensures cursor can be placed after the last badge
    html += '\u200B';

    lastIndex = match.startIndex + match.fullMatch.length;
  }

  // Add remaining text after last mention
  if (lastIndex < text.length) {
    html += escapeHTML(text.slice(lastIndex));
  }

  return html;
}

// ============================================================================
// Check if mentions have changed (for determining if we need to re-render HTML)
// ============================================================================

function getBadgeSignature(
  text: string,
  skillSlugs: string[],
  sourceSlugs: string[],
  slashCommandNames: string[],
): string {
  const matches: InlineBadgeMatch[] = [
    ...findMentionMatches(text, skillSlugs, sourceSlugs),
    ...findSlashCommandMatches(text, slashCommandNames),
  ].sort((a, b) => a.startIndex - b.startIndex);
  return matches.map((m) => `${m.type}:${m.id}:${m.startIndex}`).join('|');
}

export function shouldSyncRenderedValue(
  lastValue: string,
  nextValue: string,
  lastBadgeSignature: string,
  nextBadgeSignature: string,
): boolean {
  return lastValue !== nextValue || lastBadgeSignature !== nextBadgeSignature;
}

// ============================================================================
// RotatingPlaceholder Component
// Animated placeholder that cycles through an array of strings with fade transitions.
// Stays visible even when input is focused (until user types).
// ============================================================================

interface RotatingPlaceholderProps {
  /** Array of placeholder strings to rotate through */
  placeholders: string[];
  /** Interval in ms between rotations (default: 5000) */
  intervalMs?: number;
  /** Additional className for styling */
  className?: string;
}

function RotatingPlaceholder({
  placeholders,
  intervalMs = 5000,
  className,
}: RotatingPlaceholderProps) {
  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [opacity, setOpacity] = React.useState(1);

  React.useEffect(() => {
    // Don't rotate if only one placeholder
    if (placeholders.length <= 1) return;

    const interval = setInterval(() => {
      // Fade out
      setOpacity(0);

      // After fade out (300ms), swap text and fade back in
      setTimeout(() => {
        setCurrentIndex((prev) => (prev + 1) % placeholders.length);
        setOpacity(1);
      }, 300);
    }, intervalMs);

    return () => clearInterval(interval);
  }, [placeholders.length, intervalMs]);

  return (
    <div
      className={cn('transition-opacity duration-300 ease-in-out', className)}
      style={{ opacity }}
    >
      {placeholders[currentIndex]}
    </div>
  );
}

// ============================================================================
// RichTextInput Component
// ============================================================================

export const RichTextInput = React.forwardRef<
  RichTextInputHandle,
  RichTextInputProps
>((
  {
    value,
    onChange,
    placeholder,
    skills = [],
    sources = [],
    workspaceId,
    slashCommandNames = [],
    disabled = false,
    className,
    style,
    onFocus,
    onBlur,
    onKeyDown,
    onInput,
    onPaste,
    onLongTextPaste,
    ...restProps
  },
  forwardedRef,
) => {
  const { t } = useTranslation();
  const safeValue = React.useMemo(() => coerceInputText(value), [value]);
  const divRef = React.useRef<HTMLDivElement>(null);
  const isComposing = React.useRef(false);
  const [isComposingState, setIsComposingState] = React.useState(false);
  const lastValueRef = React.useRef(safeValue);
  const cursorPositionRef = React.useRef(0);
  const lastMentionSignatureRef = React.useRef('');
  const isInternalUpdate = React.useRef(false);
  // Pending cursor position to restore after external value update (e.g., after @mention selection)
  const pendingCursorRef = React.useRef<number | null>(null);

  const skillSlugs = React.useMemo(() => skills.map((s) => s.slug), [skills]);
  const sourceSlugs = React.useMemo(
    () => sources.map((s) => s.config.slug),
    [sources],
  );

  // Preload icons for sources and skills
  React.useEffect(() => {
    if (!workspaceId) return;

    // Preload source icons
    for (const source of sources) {
      loadSourceIcon({ config: source.config, workspaceId });
    }

    // Preload skill icons (handles emoji, URL, file, and auto-discovery)
    for (const skill of skills) {
      loadSkillIcon(skill, workspaceId);
    }
  }, [sources, skills, workspaceId]);

  // Expose imperative handle
  React.useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => divRef.current?.focus(),
      blur: () => divRef.current?.blur(),
      get value() {
        return lastValueRef.current;
      },
      get selectionStart() {
        return cursorPositionRef.current;
      },
      setValue: (newValue: string) => {
        lastValueRef.current = newValue;
      },
      setSelectionRange: (start: number, _end: number) => {
        // Store pending cursor for when external value sync runs
        pendingCursorRef.current = start;
        cursorPositionRef.current = start;
        if (divRef.current) {
          setCursorPosition(divRef.current, start);
        }
      },
      getBoundingClientRect: () =>
        divRef.current?.getBoundingClientRect() ?? new DOMRect(),
      getCaretRect: () => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        // If rect has zero dimensions (collapsed selection at line start), use a fallback
        if (
          rect.width === 0 &&
          rect.height === 0 &&
          rect.x === 0 &&
          rect.y === 0
        ) {
          // Insert a temporary span to measure position
          const span = document.createElement('span');
          span.textContent = '\u200B'; // Zero-width space
          range.insertNode(span);
          const spanRect = span.getBoundingClientRect();
          span.remove();
          // Restore selection
          selection.removeAllRanges();
          selection.addRange(range);
          return spanRect;
        }
        return rect;
      },
      get element() {
        return divRef.current;
      },
    }),
    [],
  );

  // Handle input events
  const handleInput = React.useCallback(() => {
    if (isComposing.current) return;
    if (!divRef.current) return;

    const newText = getTextFromElement(divRef.current);
    const cursorPos = getCursorPosition(
      divRef.current,
      cursorPositionRef.current,
    );

    lastValueRef.current = newText;
    cursorPositionRef.current = cursorPos;

    // Check if mentions changed - if so, we need to re-render HTML
    const newSignature = getBadgeSignature(
      newText,
      skillSlugs,
      sourceSlugs,
      slashCommandNames,
    );
    if (newSignature !== lastMentionSignatureRef.current) {
      lastMentionSignatureRef.current = newSignature;
      // Re-render with badges
      isInternalUpdate.current = true;
      const html = textToHTML(
        newText,
        skills,
        sources,
        workspaceId,
        slashCommandNames,
      );
      divRef.current.innerHTML = html || '<br>'; // Empty contenteditable needs a BR
      // Restore cursor
      setCursorPosition(divRef.current, cursorPos);
      isInternalUpdate.current = false;
    }

    onChange(newText);
    onInput?.(newText, cursorPos);
  }, [
    onChange,
    onInput,
    skills,
    sources,
    skillSlugs,
    sourceSlugs,
    workspaceId,
    slashCommandNames,
  ]);

  // Handle composition (IME)
  const handleCompositionStart = React.useCallback(() => {
    isComposing.current = true;
    setIsComposingState(true);
  }, []);

  const handleCompositionEnd = React.useCallback(() => {
    isComposing.current = false;
    setIsComposingState(false);
    handleInput();
  }, [handleInput]);

  const handleKeyDownInternal = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (isEscapeDuringComposition(e, isComposing.current)) {
        e.stopPropagation();
        return;
      }

      onKeyDown?.(e);
    },
    [onKeyDown],
  );

  // Handle paste - delegate files to parent, manually insert plain text
  const handlePasteInternal = React.useCallback(
    (e: React.ClipboardEvent) => {
      // Check if we have files - let parent handle that
      const hasFiles =
        e.clipboardData?.files && e.clipboardData.files.length > 0;
      if (hasFiles && onPaste) {
        e.preventDefault();
        onPaste(e);
        return;
      }

      // Prevent default to avoid HTML paste, then insert plain text manually
      e.preventDefault();

      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;

      // Check if text is too long - convert to file attachment instead
      const lineCount = text.split('\n').length;
      if (lineCount > LONG_TEXT_LINE_THRESHOLD && onLongTextPaste) {
        onLongTextPaste(text);
        return;
      }

      // Use execCommand to insert text - this integrates with the browser's
      // native undo stack so CMD+Z works after paste. Manual DOM manipulation
      // (range.insertNode) bypasses the undo history.
      document.execCommand('insertText', false, text);
    },
    [onPaste, onLongTextPaste],
  );

  // Handle focus
  const handleFocus = React.useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      // Tell browser to use <br> instead of <div> for line breaks.
      // This prevents div-wrapping when typing before non-editable spans (badges).
      document.execCommand('defaultParagraphSeparator', false, 'br');
      onFocus?.(e);
    },
    [onFocus],
  );

  // Handle blur
  const handleBlur = React.useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      onBlur?.(e);
    },
    [onBlur],
  );

  // Sync value from props (when parent updates value externally)
  React.useEffect(() => {
    if (!divRef.current) return;
    if (isInternalUpdate.current) return;
    const nextMentionSignature = getBadgeSignature(
      safeValue,
      skillSlugs,
      sourceSlugs,
      slashCommandNames,
    );
    if (
      !shouldSyncRenderedValue(
        lastValueRef.current,
        safeValue,
        lastMentionSignatureRef.current,
        nextMentionSignature,
      )
    ) {
      return;
    }

    // External value change - update content
    lastValueRef.current = safeValue;
    lastMentionSignatureRef.current = nextMentionSignature;

    const html = textToHTML(
      safeValue,
      skills,
      sources,
      workspaceId,
      slashCommandNames,
    );
    divRef.current.innerHTML = html || '<br>';

    // Restore cursor position after innerHTML update.
    // Only restore if:
    // 1. We have a pending position from setSelectionRange (explicit programmatic positioning), OR
    // 2. The element is actually focused (user is actively editing)
    // This prevents stealing focus during session changes when search is active.
    if (
      pendingCursorRef.current !== null ||
      document.activeElement === divRef.current
    ) {
      const cursorPos =
        pendingCursorRef.current ??
        cursorPositionRef.current ??
        safeValue.length;
      setCursorPosition(divRef.current, cursorPos);
      pendingCursorRef.current = null; // Clear after use
    }
  }, [
    safeValue,
    skills,
    sources,
    skillSlugs,
    sourceSlugs,
    workspaceId,
    slashCommandNames,
  ]);

  // Initialize content on mount
  React.useEffect(() => {
    if (!divRef.current) return;
    lastMentionSignatureRef.current = getBadgeSignature(
      safeValue,
      skillSlugs,
      sourceSlugs,
      slashCommandNames,
    );
    const html = textToHTML(
      safeValue,
      skills,
      sources,
      workspaceId,
      slashCommandNames,
    );
    divRef.current.innerHTML = html || '<br>';
    lastValueRef.current = safeValue;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle selection changes to highlight badges when selected
  React.useEffect(() => {
    // Get selection color from CSS variable (accent with transparency)
    const getSelectionColor = () => {
      const accent = getComputedStyle(document.documentElement)
        .getPropertyValue('--accent')
        .trim();
      // Return accent color with 40% opacity
      return accent
        ? `oklch(${accent.replace('oklch(', '').replace(')', '')} / 0.4)`
        : 'rgba(99, 102, 241, 0.4)';
    };

    const handleSelectionChange = () => {
      if (!divRef.current) return;

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);

      // Get all mention badges
      const badges = divRef.current.querySelectorAll(
        '.mention-badge',
      ) as NodeListOf<HTMLElement>;

      badges.forEach((badge) => {
        // Check if badge is within selection range
        const badgeRange = document.createRange();
        badgeRange.selectNode(badge);

        const isSelected =
          range.compareBoundaryPoints(Range.START_TO_END, badgeRange) > 0 &&
          range.compareBoundaryPoints(Range.END_TO_START, badgeRange) < 0;

        if (isSelected) {
          badge.style.backgroundColor = getSelectionColor();
          badge.classList.remove('bg-background');
        } else {
          badge.style.backgroundColor = '';
          badge.classList.add('bg-background');
        }
      });
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    return () =>
      document.removeEventListener('selectionchange', handleSelectionChange);
  }, []);

  // Normalize placeholder to array for RotatingPlaceholder
  const placeholderArray = React.useMemo(() => {
    if (placeholder == null) return [t('chatInput.placeholder.typeMessage')];
    if (Array.isArray(placeholder)) {
      const entries = placeholder.filter((entry) => entry.trim().length > 0);
      return entries.length > 0
        ? entries
        : [t('chatInput.placeholder.typeMessage')];
    }
    const trimmed = placeholder.trim();
    return trimmed.length > 0 ? [placeholder] : [];
  }, [placeholder, t]);

  // Show placeholder when input is empty and not in IME composition
  // (during composition the browser renders composition text natively;
  // hiding the placeholder and keeping text visible lets the user see it)
  const showPlaceholder =
    !safeValue && !isComposingState && placeholderArray.length > 0;

  // Check if value contains any mentions (badges) to adjust line height
  const hasMentions = React.useMemo(() => {
    const mentions = parseMentions(safeValue, skillSlugs, sourceSlugs);
    return (
      mentions.skills.length > 0 ||
      mentions.sources.length > 0 ||
      mentions.files.length > 0 ||
      mentions.folders.length > 0 ||
      findSlashCommandMatches(safeValue, slashCommandNames).length > 0
    );
  }, [safeValue, skillSlugs, sourceSlugs, slashCommandNames]);

  return (
    <div className="relative">
      <div
        ref={divRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        tabIndex={disabled ? -1 : 0}
        className={cn(
          'outline-none text-sm whitespace-pre-wrap break-words',
          'min-h-[1.5em]',
          disabled && 'opacity-50 cursor-not-allowed',
          // Make text transparent when showing placeholder (so caret is still visible)
          showPlaceholder && 'text-transparent caret-foreground',
          className,
        )}
        // Use inline style for line-height to override text-sm's built-in line-height.
        style={{ ...style, lineHeight: hasMentions ? 1.45 : 1.25 }}
        onInput={handleInput}
        onKeyDown={handleKeyDownInternal}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onPaste={handlePasteInternal}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        aria-disabled={disabled}
        aria-placeholder={
          Array.isArray(placeholder) ? placeholder[0] : placeholder
        }
        role="textbox"
        aria-multiline="true"
        {...restProps}
      />
      {/* Rotating placeholder overlay - visible when empty, even when focused */}
      {showPlaceholder && (
        <RotatingPlaceholder
          placeholders={placeholderArray}
          intervalMs={5000}
          className={cn(
            'absolute inset-0 text-sm text-muted-foreground pointer-events-none select-none',
            className,
          )}
        />
      )}
    </div>
  );
});

RichTextInput.displayName = 'RichTextInput';
