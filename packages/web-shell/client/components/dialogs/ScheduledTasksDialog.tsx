/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import {
  useWorkspaceActions,
  type DaemonObservedChannelContacts,
  type DaemonScheduledTask,
  type DaemonScheduledTaskChannelTarget,
  type DaemonScheduledTaskRun,
} from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonExtensionEntry,
  DaemonWorkspaceCapability,
  DaemonWorkspaceMcpServerStatus,
  DaemonWorkspaceSkillStatus,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { getComposerTagIconUrl } from '../../utils/composerTag';
import { cssUrlValue } from '../../utils/cssUrlVar';
import { workspaceBasename } from '../../utils/workspace';
import { DialogShell } from './DialogShell';
import {
  buildCron,
  describeCron,
  describeLastRun,
  formatCountdown,
  parseCronToBuilder,
  DEFAULT_BUILDER,
  type BuilderState,
  type Frequency,
  type TranslateFn,
} from './scheduledTasksSchedule';
import {
  deliveryTargetsEqual,
  flattenScheduledTaskDeliveryTargets,
  resolveScheduledTaskDeliveryInput,
  type ScheduledTaskDeliveryOption,
} from './scheduledTaskDeliveryTargets';
import styles from './ScheduledTasksDialog.module.css';

/** Localized absolute timestamp, resilient to a bad epoch value. */
function safeLocaleString(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

/** Formats one run-history entry: localized timestamp + a kind tag, plus a
 * "skipped" tag for a legacy `withheld` entry (a fire whose precondition
 * prevented it, from before the isolated mode was removed) so it isn't shown as
 * an ordinary successful run. */
function describeRun(run: DaemonScheduledTaskRun, t: TranslateFn): string {
  const kind =
    run.kind === 'catch-up'
      ? ` · ${t('scheduledTasks.runKind.catchUp')}`
      : run.kind === 'manual'
        ? ` · ${t('scheduledTasks.runKind.manual')}`
        : '';
  const withheld = run.withheld
    ? ` · ${t('scheduledTasks.runKind.withheld')}`
    : '';
  return `${safeLocaleString(run.at)}${kind}${withheld}`;
}

interface ScheduledTasksDialogProps {
  /** Manual "run now": execute the task's prompt in its bound session (so it
   * lands in the same transcript as its scheduled runs), or in the current
   * session for an unbound task. The App wiring switches to that session. */
  onRunPrompt: (
    prompt: string,
    sessionId: string | null,
  ) => void | Promise<void>;
  /** Switch to the chat view with the composer primed to describe a task, so
   * the agent can create it conversationally via its cron_create tool. */
  onCreateViaChat: () => void;
  /** Open a task's bound session — its transcript IS the task's run history.
   * When absent, tasks fall back to the inline fire-timestamp list. */
  onOpenSession?: (sessionId: string) => void;
  /** Registered workspaces on a multi-workspace daemon (from capabilities).
   * When more than one is present the page aggregates every trusted workspace's
   * tasks (each card tagged with its workspace) and the New-task form offers a
   * workspace picker. Absent or a single entry → the plain primary-only view. */
  workspaces?: DaemonWorkspaceCapability[];
  /** Forces all task operations through this workspace's route. */
  lockedWorkspace?: DaemonWorkspaceCapability;
  channelDeliveryEnabled?: boolean;
  onError: (error: unknown, fallback: string) => void;
}

/** A stable per-card identity. Task ids are unique only WITHIN a workspace's
 * file, so the aggregated view keys on (workspace, id) — otherwise two
 * same-id tasks from different workspaces would collide in the React list and
 * in the busy/expanded per-card state. */
function taskKey(task: DaemonScheduledTask): string {
  return `${task.workspaceId ?? ''}:${task.id}`;
}

function storedDeliveryInput(target: DaemonScheduledTaskChannelTarget): string {
  return ['saved', target.channelName, target.chatId, target.threadId]
    .filter((part): part is string => typeof part === 'string')
    .join(' · ');
}

function storedDeliveryDescription(
  target: DaemonScheduledTaskChannelTarget,
  t: TranslateFn,
): string {
  const kind = target.threadId
    ? 'topic'
    : target.isGroup === true
      ? 'group'
      : 'direct';
  return [
    t(`scheduledTasks.delivery.kind.${kind}`),
    target.channelName,
    target.chatId,
    target.threadId,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' · ');
}

const FREQUENCIES: Frequency[] = [
  'daily',
  'weekdays',
  'weekly',
  'hourly',
  'minutes',
  'custom',
];

// Divisors of 60 only: a non-divisor `*/N` is anchored to the hour and fires
// more often than "every N minutes" implies, so the picker offers only values
// that actually mean "every N minutes".
const MINUTE_INTERVALS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
// The largest delay window.setTimeout handles without 32-bit overflow (~24.8
// days); larger values fire immediately.
const MAX_SET_TIMEOUT_MS = 2_147_483_647;
// A task past its nextRunAt reports the same past value on every fetch. Reload
// promptly this many times (to catch a just-fired task advancing), then fall
// back to the slow lane so a permanently-stuck task can't spin a 1 Hz GET loop.
const PAST_DUE_FAST_RELOADS = 3;
const OVERDUE_RELOAD_INTERVAL_MS = 30_000;
const MAX_PROMPT_LENGTH = 100_000;
const EMPTY_OBSERVED_CONTACTS: DaemonObservedChannelContacts = {
  users: [],
  groups: [],
};
const AT_REFERENCE_UNSAFE_CHARS = /[^\p{L}\p{N}_.-]/gu;
const PROMPT_REFERENCE_TOKEN =
  /(^|[\s])(@(?:ext|mcp):(?:\\.[^\s\\]*|[^\s\\])+|\/(?:\\.[^\s\\/]*|[^\s\\/])+)(?=$|\s)/gu;
const REFERENCE_PICKER_THEME_VARS = [
  '--background',
  '--foreground',
  '--muted',
  '--muted-foreground',
  '--border',
  '--error-color',
  '--font-mono',
];

type PromptTagKind = 'extension' | 'skill' | 'mcp';

interface PromptReferenceItem {
  id: string;
  kind: PromptTagKind;
  label: string;
  description?: string;
  insertText: string;
}

interface ReferencePickerPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

function escapeAtReferenceText(ref: string): string {
  return ref.replace(AT_REFERENCE_UNSAFE_CHARS, '\\$&');
}

function unescapeReferenceText(ref: string): string {
  return ref.replace(/\\(.)/g, '$1');
}

function promptReferenceItemFromToken(
  token: string,
): PromptReferenceItem | null {
  if (token.startsWith('@ext:')) {
    const label = unescapeReferenceText(token.slice('@ext:'.length));
    return {
      id: `extension:${label}`,
      kind: 'extension',
      label,
      insertText: token,
    };
  }
  if (token.startsWith('@mcp:')) {
    const label = unescapeReferenceText(token.slice('@mcp:'.length));
    return {
      id: `mcp:${label}`,
      kind: 'mcp',
      label,
      insertText: token,
    };
  }
  if (token.startsWith('/')) {
    const label = unescapeReferenceText(token.slice(1));
    if (!label) return null;
    return {
      id: `skill:${label}`,
      kind: 'skill',
      label,
      insertText: token,
    };
  }
  return null;
}

function extensionDescription(extension: DaemonExtensionEntry) {
  if (extension.displayName && extension.displayName !== extension.name) {
    return extension.displayName;
  }
  return extension.description;
}

function skillDescription(skill: DaemonWorkspaceSkillStatus) {
  return skill.description || skill.argumentHint || skill.level;
}

function mcpDescription(server: DaemonWorkspaceMcpServerStatus) {
  return server.description || server.mcpStatus;
}

function textFromPromptNode(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }
  if (!(node instanceof HTMLElement)) return '';

  const serialized = node.dataset.promptTagSerialized;
  if (serialized) return serialized;
  if (node.tagName === 'BR') return '\n';

  let text = '';
  node.childNodes.forEach((child) => {
    text += textFromPromptNode(child);
  });
  return node.tagName === 'DIV' || node.tagName === 'P' ? `${text}\n` : text;
}

function textFromPromptChildren(root: ParentNode): string {
  let text = '';
  root.childNodes.forEach((node) => {
    text += textFromPromptNode(node);
  });
  return text;
}

function normalizePromptText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\n$/, '');
}

function textFromPromptEditor(root: HTMLElement): string {
  return normalizePromptText(textFromPromptChildren(root));
}

function textFromPromptFragment(fragment: DocumentFragment): string {
  return normalizePromptText(textFromPromptChildren(fragment));
}

function clearPromptEditor(root: HTMLElement) {
  while (root.firstChild) root.removeChild(root.firstChild);
}

function appendPromptText(root: HTMLElement, text: string) {
  if (text) root.appendChild(document.createTextNode(text));
}

function setPromptEditorText(root: HTMLElement, text: string) {
  clearPromptEditor(root);
  if (!text) return;
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) root.appendChild(document.createElement('br'));
    appendPromptLine(root, line);
  });
}

function normalizePromptEditor(root: HTMLElement): string {
  let next = textFromPromptEditor(root);
  if (next.length > MAX_PROMPT_LENGTH) {
    next = next.slice(0, MAX_PROMPT_LENGTH);
    setPromptEditorText(root, next);
  } else if (next.trim().length === 0) {
    clearPromptEditor(root);
    next = '';
  }
  return next;
}

function insertPlainPromptText(root: HTMLElement, text: string) {
  const remaining = MAX_PROMPT_LENGTH - textFromPromptEditor(root).length;
  if (remaining <= 0) return;
  document.execCommand('insertText', false, text.slice(0, remaining));
}

function selectedPromptText(root: HTMLElement): {
  selection: Selection;
  text: string;
} | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  return {
    selection,
    text: textFromPromptFragment(range.cloneContents()),
  };
}

function makePromptTagElement(item: PromptReferenceItem): HTMLElement {
  const tag = document.createElement('span');
  tag.className = styles.promptTag;
  tag.contentEditable = 'false';
  tag.dataset.promptTagSerialized = item.insertText.trim();

  const iconUrl = getComposerTagIconUrl(item.kind);
  if (iconUrl) {
    const icon = document.createElement('span');
    icon.className = styles.promptTagIcon;
    icon.style.setProperty('--composer-tag-icon-url', cssUrlValue(iconUrl));
    icon.setAttribute('aria-hidden', 'true');
    tag.appendChild(icon);
  }

  const value = document.createElement('span');
  value.className = styles.promptTagValue;
  value.textContent = item.label;
  tag.appendChild(value);
  return tag;
}

function appendPromptLine(root: HTMLElement, line: string) {
  let cursor = 0;
  PROMPT_REFERENCE_TOKEN.lastIndex = 0;
  for (const match of line.matchAll(PROMPT_REFERENCE_TOKEN)) {
    const [matched, prefix, token] = match;
    const index = match.index ?? 0;
    const item = promptReferenceItemFromToken(token);
    if (!item) continue;
    appendPromptText(root, line.slice(cursor, index));
    appendPromptText(root, prefix);
    root.appendChild(makePromptTagElement(item));
    cursor = index + matched.length;
  }
  appendPromptText(root, line.slice(cursor));
}

function insertPromptTagElement(root: HTMLElement, item: PromptReferenceItem) {
  const selection = window.getSelection();
  const tag = makePromptTagElement(item);
  const spacer = document.createTextNode(' ');

  if (textFromPromptEditor(root).trim().length === 0) {
    clearPromptEditor(root);
  }

  const lastText = root.lastChild?.textContent ?? '';
  if (root.childNodes.length > 0 && !/\s$/.test(lastText)) {
    root.appendChild(document.createTextNode(' '));
  }
  root.appendChild(tag);
  root.appendChild(spacer);

  const range = document.createRange();
  range.setStartAfter(spacer);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function PromptReferenceEditor({
  value,
  label,
  placeholder,
  onChange,
  insertItem,
  onInserted,
}: {
  value: string;
  label: string;
  placeholder: string;
  onChange: (value: string) => void;
  insertItem: PromptReferenceItem | null;
  onInserted: () => void;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastAppliedValueRef = useRef('');

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (value === lastAppliedValueRef.current) return;
    setPromptEditorText(editor, value);
    lastAppliedValueRef.current = value;
  }, [value]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !insertItem) return;
    insertPromptTagElement(editor, insertItem);
    const next = textFromPromptEditor(editor);
    lastAppliedValueRef.current = next;
    onChange(next);
    editor.focus();
    onInserted();
  }, [insertItem, onChange, onInserted]);

  return (
    <div className={styles.promptEditorWrap}>
      <div
        ref={editorRef}
        className={styles.promptEditor}
        contentEditable
        role="textbox"
        aria-label={label}
        aria-multiline="true"
        aria-placeholder={placeholder}
        onInput={(event) => {
          const next = normalizePromptEditor(event.currentTarget);
          lastAppliedValueRef.current = next;
          onChange(next);
        }}
        onPaste={(event) => {
          event.preventDefault();
          insertPlainPromptText(
            event.currentTarget,
            event.clipboardData.getData('text/plain'),
          );
        }}
        onDrop={(event) => {
          event.preventDefault();
          insertPlainPromptText(
            event.currentTarget,
            event.dataTransfer.getData('text/plain'),
          );
        }}
        onCopy={(event) => {
          const selected = selectedPromptText(event.currentTarget);
          if (!selected) return;
          event.preventDefault();
          event.clipboardData.setData('text/plain', selected.text);
        }}
        onCut={(event) => {
          const selected = selectedPromptText(event.currentTarget);
          if (!selected) return;
          event.preventDefault();
          event.clipboardData.setData('text/plain', selected.text);
          selected.selection.deleteFromDocument();
          const next = normalizePromptEditor(event.currentTarget);
          lastAppliedValueRef.current = next;
          onChange(next);
        }}
      />
      {value.trim().length === 0 && (
        <div className={styles.promptPlaceholder}>{placeholder}</div>
      )}
    </div>
  );
}

export function ScheduledTasksDialog({
  onRunPrompt,
  onCreateViaChat,
  onOpenSession,
  workspaces,
  lockedWorkspace,
  channelDeliveryEnabled = false,
  onError,
}: ScheduledTasksDialogProps) {
  const { t } = useI18n();
  const actions = useWorkspaceActions();

  // Multi-workspace aggregation. `workspaces` mirrors the daemon capabilities;
  // with more than one the page lists every trusted workspace's tasks together
  // and the New form offers a workspace picker. A single (or absent) workspace
  // keeps the original primary-only view — no badges, no picker. Memoized so the
  // derived arrays are stable identities — `reload` depends on them, and a fresh
  // array each render would re-fire its mount effect in a loop.
  const workspaceList = useMemo(() => workspaces ?? [], [workspaces]);
  const isMultiWorkspace = !lockedWorkspace && workspaceList.length > 1;
  // The workspaces the page can actually read + write: every trusted one, PLUS
  // the primary even when it is untrusted. The primary is reached through the
  // trust-free unqualified route (the same one the single-workspace page always
  // used), so excluding an untrusted primary would silently drop its readable
  // tasks from the aggregate AND desync the create picker (its default targets
  // the primary, so the primary must be a selectable option). Secondaries stay
  // gated on trust — their qualified route rejects an untrusted read/write.
  const operableWorkspaces = useMemo(
    () => workspaceList.filter((ws) => ws.primary || ws.trusted),
    [workspaceList],
  );
  // The workspace id to pass to the per-task actions: primary uses its
  // trust-free unqualified route (undefined), secondaries their qualified one.
  const workspaceActionId = useCallback(
    (ws: DaemonWorkspaceCapability): string | undefined =>
      ws.primary ? undefined : ws.id,
    [],
  );
  const lockedWorkspaceId = lockedWorkspace
    ? workspaceActionId(lockedWorkspace)
    : undefined;

  const [tasks, setTasks] = useState<DaemonScheduledTask[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The task whose manual "run now" is mid-flight (switching to its session +
  // enqueuing). Serialized to one at a time so overlapping runs can't drop a
  // prompt on the App's single bound-run latch.
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);

  // Create / edit form. `editingId` null = create, otherwise the id of the
  // task being edited (the form is dual-mode — same fields, different verb).
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The workspace the form targets. On create it's the picker's value (undefined
  // = primary); on edit it's pinned to the task's own workspace (a task can't
  // move files, so the picker is read-only). Passed to create/update actions.
  const [formWorkspaceId, setFormWorkspaceId] = useState<string | undefined>(
    lockedWorkspaceId,
  );
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [builder, setBuilder] = useState<BuilderState>(DEFAULT_BUILDER);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deliveryInput, setDeliveryInput] = useState('');
  const [initialDeliveryTarget, setInitialDeliveryTarget] =
    useState<DaemonScheduledTaskChannelTarget>();
  const [deliveryOptions, setDeliveryOptions] = useState<
    ScheduledTaskDeliveryOption[]
  >([]);
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [referenceKind, setReferenceKind] = useState<PromptTagKind | null>(
    null,
  );
  const [referenceItems, setReferenceItems] = useState<PromptReferenceItem[]>(
    [],
  );
  const [referenceLoading, setReferenceLoading] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [pendingPromptTag, setPendingPromptTag] =
    useState<PromptReferenceItem | null>(null);
  const referencePopoverRef = useRef<HTMLDivElement | null>(null);
  const referencePickerRef = useRef<HTMLDivElement | null>(null);
  const [referencePickerPosition, setReferencePickerPosition] =
    useState<ReferencePickerPosition | null>(null);
  const [referencePickerThemeVars, setReferencePickerThemeVars] =
    useState<CSSProperties>({});

  // Which task's run history is expanded inline (only one at a time).
  const [expandedRunsId, setExpandedRunsId] = useState<string | null>(null);

  // Wall-clock, ticked every second, that the per-task next-run countdowns are
  // measured against. Only runs while at least one task has a next run.
  const [now, setNow] = useState(() => Date.now());

  // Guard against setState after unmount (loads are async).
  const mountedRef = useRef(true);
  // Monotonic reload id: a slow mount/Refresh load that resolves after a
  // create/toggle/delete's reload must not overwrite the newer list with
  // stale data. Only the latest reload is allowed to apply its result.
  const reloadSeqRef = useRef(0);
  const referenceLoadSeqRef = useRef(0);
  const deliveryLoadSeqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    try {
      let list: DaemonScheduledTask[];
      let firstError: string | null = null;
      if (lockedWorkspace) {
        list = (await actions.listScheduledTasks(lockedWorkspaceId)).map(
          (task) => ({
            ...task,
            workspaceId: lockedWorkspaceId,
            workspaceCwd: lockedWorkspace.cwd,
          }),
        );
      } else if (isMultiWorkspace) {
        // Fan out over every OPERABLE workspace (trusted secondaries + the
        // primary, which is always reachable via its trust-free route) and tag
        // each task with its workspace so the cards can badge it and the
        // mutations can target its file. One workspace failing (corrupt file,
        // etc.) must not blank the whole list — keep the others and surface the
        // first error.
        const results = await Promise.all(
          operableWorkspaces.map(async (ws) => {
            try {
              const tasks = await actions.listScheduledTasks(
                workspaceActionId(ws),
              );
              return tasks.map((task) => ({
                ...task,
                workspaceId: workspaceActionId(ws),
                workspaceCwd: ws.cwd,
              }));
            } catch (err) {
              if (!firstError) {
                firstError = err instanceof Error ? err.message : String(err);
              }
              return [] as DaemonScheduledTask[];
            }
          }),
        );
        list = results.flat();
      } else {
        list = await actions.listScheduledTasks();
      }
      if (!mountedRef.current || seq !== reloadSeqRef.current) return;
      // Newest first — matches the reference "sort by created, descending".
      const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt);
      setTasks(sorted);
      setLoadError(firstError);
    } catch (err) {
      if (!mountedRef.current || seq !== reloadSeqRef.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
      setTasks((prev) => prev ?? []);
    }
  }, [
    actions,
    isMultiWorkspace,
    lockedWorkspace,
    lockedWorkspaceId,
    operableWorkspaces,
    workspaceActionId,
  ]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Tick the countdown clock once a second, but only while something is
  // actually counting down — an all-disabled (or empty) list needs no timer.
  const hasCountdown = !!tasks?.some((task) => task.nextRunAt != null);
  useEffect(() => {
    if (!hasCountdown) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasCountdown]);

  // Refresh the list shortly after the soonest task is due, so its countdown
  // rolls to the next occurrence and lastFiredAt / run history refresh too.
  const pastDueReloadsRef = useRef(0);
  useEffect(() => {
    if (!tasks) return;
    let soonest = Infinity;
    for (const task of tasks) {
      if (task.nextRunAt != null && task.nextRunAt < soonest) {
        soonest = task.nextRunAt;
      }
    }
    if (!Number.isFinite(soonest)) return;
    const remaining = soonest - Date.now();
    let delay: number;
    if (remaining > 0) {
      pastDueReloadsRef.current = 0;
      // Reload just after the fire (+2s). Clamp to the 32-bit setTimeout ceiling
      // (~24.8 days) so a months-away schedule can't overflow to fire-immediately
      // and re-arm in a tight loop.
      delay = Math.min(remaining + 2000, MAX_SET_TIMEOUT_MS);
    } else {
      // Already past due. A task that just fired advances its nextRunAt within a
      // couple of prompt reloads; one that stays past due (unbound with no lock
      // owner, or a bound session that won't revive) never advances — back off
      // to a slow lane so the page doesn't spin a 1 Hz GET /scheduled-tasks loop.
      const n = pastDueReloadsRef.current++;
      delay = n < PAST_DUE_FAST_RELOADS ? 1000 : OVERDUE_RELOAD_INTERVAL_MS;
    }
    const id = window.setTimeout(() => void reload(), delay);
    return () => window.clearTimeout(id);
  }, [tasks, reload]);

  const previewCron = buildCron(builder);
  const previewLabel = previewCron ? describeCron(previewCron, t) : null;

  const updateReferencePickerPosition = useCallback(() => {
    const anchor = referencePopoverRef.current;
    if (!anchor) {
      setReferencePickerPosition(null);
      return;
    }
    const computedStyle = getComputedStyle(anchor);
    setReferencePickerThemeVars(
      Object.fromEntries(
        REFERENCE_PICKER_THEME_VARS.map((name) => [
          name,
          computedStyle.getPropertyValue(name),
        ]),
      ) as CSSProperties,
    );
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 24);
    const left = Math.max(
      12,
      Math.min(rect.left, window.innerWidth - width - 12),
    );
    const top = rect.bottom + 6;
    const maxHeight = Math.max(
      140,
      Math.min(320, window.innerHeight - top - 12),
    );
    setReferencePickerPosition((prev) => {
      const next = { left, top, width, maxHeight };
      return prev &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.width === next.width &&
        prev.maxHeight === next.maxHeight
        ? prev
        : next;
    });
  }, []);

  const resetReferenceState = useCallback(() => {
    referenceLoadSeqRef.current += 1;
    setReferenceKind(null);
    setReferenceItems([]);
    setReferenceLoading(false);
    setReferenceError(null);
    setPendingPromptTag(null);
    setReferencePickerPosition(null);
    setReferencePickerThemeVars({});
  }, []);

  const loadReferences = useCallback(
    async (kind: PromptTagKind) => {
      const seq = ++referenceLoadSeqRef.current;
      if (referenceKind === kind) {
        resetReferenceState();
        return;
      }
      updateReferencePickerPosition();
      setReferenceKind(kind);
      setReferenceLoading(true);
      setReferenceError(null);
      setReferenceItems([]);
      try {
        let items: PromptReferenceItem[];
        if (kind === 'extension') {
          const status = await actions.loadExtensionsStatus();
          items = (status.extensions ?? [])
            .filter((extension) => extension.isActive)
            .map((extension) => ({
              id: extension.id || extension.name,
              kind,
              label: extension.name,
              description: extensionDescription(extension),
              insertText: `@ext:${escapeAtReferenceText(extension.name)} `,
            }));
        } else if (kind === 'skill') {
          const status = await actions.loadSkillsStatus();
          items = (status.skills ?? [])
            .filter((skill) => skill.modelInvocable)
            .map((skill) => ({
              id: skill.name,
              kind,
              label: skill.name,
              description: skillDescription(skill),
              insertText: `/${escapeAtReferenceText(skill.name)} `,
            }));
        } else {
          const status = await actions.loadMcpStatus();
          items = (status.servers ?? [])
            .filter((server) => !server.disabled)
            .map((server) => ({
              id: server.name,
              kind,
              label: server.name,
              description: mcpDescription(server),
              insertText: `@mcp:${escapeAtReferenceText(server.name)} `,
            }));
        }
        if (!mountedRef.current || seq !== referenceLoadSeqRef.current) return;
        setReferenceItems(items);
      } catch (err) {
        if (!mountedRef.current || seq !== referenceLoadSeqRef.current) return;
        setReferenceError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mountedRef.current && seq === referenceLoadSeqRef.current) {
          setReferenceLoading(false);
        }
      }
    },
    [
      actions,
      referenceKind,
      resetReferenceState,
      updateReferencePickerPosition,
    ],
  );

  useEffect(() => {
    if (!referenceKind) return;
    updateReferencePickerPosition();

    const handlePointerDown = (event: PointerEvent) => {
      const popover = referencePopoverRef.current;
      const picker = referencePickerRef.current;
      if (popover?.contains(event.target as Node)) return;
      if (picker?.contains(event.target as Node)) return;
      resetReferenceState();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        resetReferenceState();
      }
    };

    const handleReposition = () => updateReferencePickerPosition();

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [referenceKind, resetReferenceState, updateReferencePickerPosition]);

  useEffect(() => {
    if (!channelDeliveryEnabled || !showForm) return;
    const seq = ++deliveryLoadSeqRef.current;
    setDeliveryLoading(true);
    setDeliveryError(null);
    void actions
      .listObservedChannelContacts(formWorkspaceId)
      .then((contacts) => {
        if (!mountedRef.current || seq !== deliveryLoadSeqRef.current) return;
        const options = flattenScheduledTaskDeliveryTargets(
          contacts ?? EMPTY_OBSERVED_CONTACTS,
        );
        setDeliveryOptions(options);
        if (initialDeliveryTarget) {
          const current = options.find((item) =>
            deliveryTargetsEqual(item.target, initialDeliveryTarget),
          );
          if (current) {
            setDeliveryInput((value) =>
              value === storedDeliveryInput(initialDeliveryTarget)
                ? current.inputValue
                : value,
            );
          }
        }
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || seq !== deliveryLoadSeqRef.current) return;
        setDeliveryOptions([]);
        setDeliveryError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (mountedRef.current && seq === deliveryLoadSeqRef.current) {
          setDeliveryLoading(false);
        }
      });
  }, [
    actions,
    channelDeliveryEnabled,
    formWorkspaceId,
    initialDeliveryTarget,
    showForm,
  ]);

  const resetForm = useCallback(() => {
    setName('');
    setPrompt('');
    setBuilder(DEFAULT_BUILDER);
    setFormError(null);
    setShowForm(false);
    setEditingId(null);
    setFormWorkspaceId(lockedWorkspaceId);
    setDeliveryInput('');
    setInitialDeliveryTarget(undefined);
    setDeliveryOptions([]);
    setDeliveryLoading(false);
    setDeliveryError(null);
    deliveryLoadSeqRef.current++;
    resetReferenceState();
  }, [lockedWorkspaceId, resetReferenceState]);

  const openCreate = useCallback(() => {
    setEditingId(null);
    // Default to the locked workspace, or primary when the page is unlocked.
    // In the latter case the picker can move it to a trusted secondary.
    setFormWorkspaceId(lockedWorkspaceId);
    setName('');
    setPrompt('');
    setBuilder(DEFAULT_BUILDER);
    setFormError(null);
    setDeliveryInput('');
    setInitialDeliveryTarget(undefined);
    setDeliveryOptions([]);
    setDeliveryError(null);
    resetReferenceState();
    setShowForm(true);
  }, [lockedWorkspaceId, resetReferenceState]);

  const openEdit = useCallback(
    (task: DaemonScheduledTask) => {
      setEditingId(task.id);
      // Pin the edit to the task's own workspace — a PATCH can't move a task
      // between per-workspace files, so the picker is read-only while editing.
      setFormWorkspaceId(task.workspaceId);
      setName(task.name ?? '');
      setPrompt(task.prompt);
      // Reverse the cron back onto the pickers; an expression the pickers can't
      // represent lands in the `custom` field, never silently rewritten.
      setBuilder(parseCronToBuilder(task.cron));
      setFormError(null);
      const target = task.delivery?.target;
      setInitialDeliveryTarget(target);
      setDeliveryInput(target ? storedDeliveryInput(target) : '');
      setDeliveryOptions([]);
      setDeliveryError(null);
      resetReferenceState();
      setShowForm(true);
    },
    [resetReferenceState],
  );

  const handleSubmit = useCallback(async () => {
    const cron = buildCron(builder);
    if (!cron) {
      setFormError(t('scheduledTasks.error.invalidSchedule'));
      return;
    }
    if (prompt.trim().length === 0) {
      setFormError(t('scheduledTasks.error.emptyPrompt'));
      return;
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      setFormError(
        t('scheduledTasks.error.promptTooLong', {
          max: MAX_PROMPT_LENGTH,
        }),
      );
      return;
    }
    const trimmedDeliveryInput = deliveryInput.trim();
    const selectedDelivery = resolveScheduledTaskDeliveryInput(
      trimmedDeliveryInput,
      deliveryOptions,
    );
    const unchangedStoredDelivery =
      initialDeliveryTarget !== undefined &&
      (trimmedDeliveryInput === storedDeliveryInput(initialDeliveryTarget) ||
        deliveryTargetsEqual(selectedDelivery?.target, initialDeliveryTarget));
    if (
      channelDeliveryEnabled &&
      trimmedDeliveryInput.length > 0 &&
      !selectedDelivery &&
      !unchangedStoredDelivery
    ) {
      setFormError(t('scheduledTasks.delivery.unobserved'));
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      if (editingId) {
        // Update only the editable fields; `recurring`/`enabled` are omitted so
        // the PATCH leaves them unchanged (recurring isn't in this form, and
        // enabled is driven by the card toggle). Empty name clears it.
        const patch = {
          cron,
          prompt: prompt.trim(),
          name: name.trim() || null,
          ...(channelDeliveryEnabled &&
          initialDeliveryTarget !== undefined &&
          trimmedDeliveryInput.length === 0
            ? { delivery: null }
            : channelDeliveryEnabled &&
                selectedDelivery &&
                !unchangedStoredDelivery
              ? {
                  delivery: {
                    kind: 'channel' as const,
                    target: selectedDelivery.target,
                  },
                }
              : {}),
        };
        await actions.updateScheduledTask(editingId, patch, formWorkspaceId);
      } else {
        await actions.createScheduledTask(
          {
            cron,
            prompt: prompt.trim(),
            name: name.trim() || null,
            recurring: true,
            enabled: true,
            ...(channelDeliveryEnabled && selectedDelivery
              ? {
                  delivery: {
                    kind: 'channel' as const,
                    target: selectedDelivery.target,
                  },
                }
              : {}),
          },
          formWorkspaceId,
        );
      }
      if (!mountedRef.current) return;
      resetForm();
      await reload();
    } catch (err) {
      if (!mountedRef.current) return;
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [
    actions,
    builder,
    channelDeliveryEnabled,
    deliveryInput,
    deliveryOptions,
    editingId,
    formWorkspaceId,
    name,
    initialDeliveryTarget,
    prompt,
    reload,
    resetForm,
    t,
  ]);

  const handleToggle = useCallback(
    async (task: DaemonScheduledTask) => {
      setBusyId(taskKey(task));
      try {
        await actions.updateScheduledTask(
          task.id,
          { enabled: !task.enabled },
          task.workspaceId,
        );
        await reload();
      } catch (err) {
        onError(err, t('scheduledTasks.error.toggleFailed'));
      } finally {
        if (mountedRef.current) setBusyId(null);
      }
    },
    [actions, onError, reload, t],
  );

  const handleRunNow = useCallback(
    async (task: DaemonScheduledTask) => {
      // Cheap early exit on the (possibly stale) snapshot, and serialize: only
      // one manual run in flight, since the App holds a single pending bound-run
      // latch and overlapping runs could drop a prompt.
      if (!task.enabled || runningTaskId !== null) return;
      setRunningTaskId(task.id);
      try {
        // Server-authoritative re-check right before running: the dialog's
        // snapshot can be stale — another tab/API may have disabled or deleted
        // the task since it loaded. Running then would EXECUTE the prompt in the
        // session while /run only refuses the RECORD afterward, i.e. a real
        // unrecorded run. Refresh, bail if gone/disabled, and use the FRESH
        // prompt/session so we never run an outdated one.
        const fresh = (await actions.listScheduledTasks(task.workspaceId)).find(
          (tk) => tk.id === task.id,
        );
        if (!fresh || !fresh.enabled) {
          await reload().catch(() => {});
          onError(
            new Error('This task is no longer runnable.'),
            t('scheduledTasks.error.runFailed'),
          );
          return;
        }
        if (fresh.recurring) {
          // Recurring: enqueue FIRST (onRunPrompt resolves at admission, rejects
          // if the session can't be opened), record AFTER — so a failed enqueue
          // leaves no false "ran" entry. A record failure is surfaced but the
          // history still catches up on the next refresh.
          await onRunPrompt(fresh.prompt, fresh.sessionId);
          try {
            await actions.runScheduledTask(fresh.id, task.workspaceId);
            await reload();
          } catch (err) {
            onError(err, t('scheduledTasks.error.runFailed'));
          }
        } else {
          // One-shot: /run IS its single fire — it deletes the task. Consume it
          // BEFORE enqueuing so it can't ALSO fire at its own scheduled slot (a
          // silent double execution). The trade-off is that a failed delivery
          // leaves the task gone AND un-run — and reload() has already dropped it
          // from the list — so surface THAT explicitly rather than the generic
          // "run failed", which would hide the deletion.
          await actions.runScheduledTask(fresh.id, task.workspaceId);
          await reload();
          try {
            await onRunPrompt(fresh.prompt, fresh.sessionId);
          } catch (err) {
            onError(err, t('scheduledTasks.error.oneShotConsumedButFailed'));
            return;
          }
        }
      } catch (err) {
        onError(err, t('scheduledTasks.error.runFailed'));
      } finally {
        setRunningTaskId(null);
      }
    },
    [actions, onError, onRunPrompt, reload, runningTaskId, t],
  );

  const handleDelete = useCallback(
    async (task: DaemonScheduledTask) => {
      // Truncate: an unnamed task falls back to its prompt, which can be up to
      // MAX_PROMPT_LENGTH — too long for a confirm() dialog.
      const raw = task.name || task.prompt;
      const label = raw.length > 60 ? `${raw.slice(0, 57)}…` : raw;
      if (!window.confirm(t('scheduledTasks.deleteConfirm', { name: label }))) {
        return;
      }
      setBusyId(taskKey(task));
      try {
        await actions.deleteScheduledTask(task.id, task.workspaceId);
        await reload();
      } catch (err) {
        onError(err, t('scheduledTasks.error.deleteFailed'));
      } finally {
        if (mountedRef.current) setBusyId(null);
      }
    },
    [actions, onError, reload, t],
  );

  const referencePicker =
    referenceKind && referencePickerPosition
      ? createPortal(
          <div
            ref={referencePickerRef}
            className={styles.referencePicker}
            role="listbox"
            aria-label={t('scheduledTasks.referencePicker')}
            style={
              {
                ...referencePickerThemeVars,
                left: referencePickerPosition.left,
                top: referencePickerPosition.top,
                width: referencePickerPosition.width,
                maxHeight: referencePickerPosition.maxHeight,
              } as CSSProperties
            }
          >
            {referenceLoading ? (
              <div className={styles.referenceEmpty}>
                {t('scheduledTasks.reference.loading')}
              </div>
            ) : referenceError ? (
              <div className={styles.referenceError}>{referenceError}</div>
            ) : referenceItems.length === 0 ? (
              <div className={styles.referenceEmpty}>
                {t('scheduledTasks.reference.empty')}
              </div>
            ) : (
              referenceItems.map((item) => (
                <button
                  key={`${item.kind}:${item.id}`}
                  type="button"
                  className={styles.referenceItem}
                  role="option"
                  aria-selected="false"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setPendingPromptTag(item);
                    setReferenceKind(null);
                  }}
                >
                  <span className={styles.referenceItemLabel}>
                    {item.label}
                  </span>
                  {item.description && (
                    <span className={styles.referenceItemDescription}>
                      {item.description}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={styles.root}>
      <div className={styles.intro}>{t('scheduledTasks.subtitle')}</div>

      <div className={styles.toolbar}>
        <div className={styles.count}>
          {tasks === null
            ? t('scheduledTasks.loading')
            : t('scheduledTasks.count', { count: tasks.length })}
        </div>
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => void reload()}
          >
            {t('scheduledTasks.refresh')}
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onCreateViaChat}
          >
            {t('scheduledTasks.createViaChat')}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={openCreate}
          >
            {t('scheduledTasks.new')}
          </button>
        </div>
      </div>

      {showForm && (
        <DialogShell
          title={t(
            editingId ? 'scheduledTasks.editTitle' : 'scheduledTasks.new',
          )}
          size="md"
          onClose={resetForm}
        >
          <div className={styles.formFields}>
            {isMultiWorkspace && (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>
                  {t('scheduledTasks.workspace')}
                </span>
                <select
                  className={styles.select}
                  value={formWorkspaceId ?? ''}
                  // A task lives in one workspace's file; editing can't move it,
                  // so the picker is fixed while editing and when only one
                  // workspace is operable (nothing to choose).
                  disabled={!!editingId || operableWorkspaces.length <= 1}
                  onChange={(e) => {
                    setFormWorkspaceId(e.target.value || undefined);
                    setDeliveryInput('');
                    setInitialDeliveryTarget(undefined);
                    setDeliveryOptions([]);
                    setDeliveryError(null);
                  }}
                >
                  {operableWorkspaces.map((ws) => (
                    <option key={ws.id} value={workspaceActionId(ws) ?? ''}>
                      {workspaceBasename(ws.cwd)}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {t('scheduledTasks.name')}
              </span>
              <input
                className={styles.input}
                type="text"
                value={name}
                maxLength={200}
                placeholder={t('scheduledTasks.namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {t('scheduledTasks.prompt')}
                <span className={styles.required}>*</span>
              </span>
              <PromptReferenceEditor
                value={prompt}
                label={t('scheduledTasks.prompt')}
                placeholder={t('scheduledTasks.promptPlaceholder')}
                onChange={setPrompt}
                insertItem={pendingPromptTag}
                onInserted={() => setPendingPromptTag(null)}
              />
            </label>
            <div ref={referencePopoverRef} className={styles.referencePopover}>
              <div className={styles.referenceBar}>
                {(['extension', 'skill', 'mcp'] as const).map((kind) => {
                  const iconUrl = getComposerTagIconUrl(kind);
                  return (
                    <button
                      key={kind}
                      type="button"
                      className={`${styles.referenceButton} ${
                        referenceKind === kind
                          ? styles.referenceButtonActive
                          : ''
                      }`}
                      aria-expanded={referenceKind === kind}
                      onClick={() => void loadReferences(kind)}
                    >
                      {iconUrl && (
                        <span
                          className={styles.referenceButtonIcon}
                          style={
                            {
                              '--composer-tag-icon-url': cssUrlValue(iconUrl),
                            } as CSSProperties
                          }
                          aria-hidden
                        />
                      )}
                      {t(`scheduledTasks.reference.${kind}`)}
                    </button>
                  );
                })}
              </div>
            </div>

            {channelDeliveryEnabled && (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>
                  {t('scheduledTasks.delivery.destination')}
                </span>
                <input
                  className={styles.input}
                  type="text"
                  list="scheduled-task-delivery-targets"
                  value={deliveryInput}
                  placeholder={t('scheduledTasks.delivery.placeholder')}
                  onChange={(event) => setDeliveryInput(event.target.value)}
                />
                <datalist id="scheduled-task-delivery-targets">
                  {deliveryOptions.map((option) => (
                    <option
                      key={`${option.kind}:${option.inputValue}`}
                      value={option.inputValue}
                    >
                      {option.description}
                    </option>
                  ))}
                </datalist>
                <span className={styles.fieldHint}>
                  {deliveryLoading
                    ? t('scheduledTasks.delivery.loading')
                    : deliveryError
                      ? deliveryError
                      : deliveryOptions.length === 0
                        ? t('scheduledTasks.delivery.empty')
                        : t('scheduledTasks.delivery.hint')}
                </span>
              </label>
            )}

            <div className={styles.scheduleRow}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>
                  {t('scheduledTasks.frequency')}
                </span>
                <select
                  className={styles.select}
                  value={builder.frequency}
                  onChange={(e) => {
                    const frequency = e.target.value as Frequency;
                    setBuilder((b) => ({
                      ...b,
                      frequency,
                      // The time picker is hidden for hourly, so reset the
                      // minute to :00 instead of silently carrying over the
                      // minute picked for a daily/weekly schedule.
                      ...(frequency === 'hourly' ? { time: '00:00' } : {}),
                    }));
                  }}
                >
                  {FREQUENCIES.map((f) => (
                    <option key={f} value={f}>
                      {t(`scheduledTasks.freq.${f}`)}
                    </option>
                  ))}
                </select>
              </label>

              {(builder.frequency === 'daily' ||
                builder.frequency === 'weekdays' ||
                builder.frequency === 'weekly') && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>
                    {t('scheduledTasks.time')}
                  </span>
                  <input
                    className={styles.input}
                    type="time"
                    value={builder.time}
                    onChange={(e) =>
                      setBuilder((b) => ({ ...b, time: e.target.value }))
                    }
                  />
                </label>
              )}

              {builder.frequency === 'weekly' && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>
                    {t('scheduledTasks.weekday')}
                  </span>
                  <select
                    className={styles.select}
                    value={builder.weekday}
                    onChange={(e) =>
                      setBuilder((b) => ({
                        ...b,
                        weekday: Number(e.target.value),
                      }))
                    }
                  >
                    {t('scheduledTasks.weekdayNames')
                      .split(',')
                      .map((label, idx) => (
                        <option key={idx} value={idx}>
                          {label}
                        </option>
                      ))}
                  </select>
                </label>
              )}

              {builder.frequency === 'minutes' && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>
                    {t('scheduledTasks.interval')}
                  </span>
                  <select
                    className={styles.select}
                    value={builder.minuteInterval}
                    onChange={(e) =>
                      setBuilder((b) => ({
                        ...b,
                        minuteInterval: Number(e.target.value),
                      }))
                    }
                  >
                    {MINUTE_INTERVALS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {builder.frequency === 'custom' && (
                <label className={`${styles.field} ${styles.fieldGrow}`}>
                  <span className={styles.fieldLabel}>
                    {t('scheduledTasks.cron')}
                  </span>
                  <input
                    className={styles.input}
                    type="text"
                    value={builder.customCron}
                    spellCheck={false}
                    placeholder="0 9 * * 1-5"
                    onChange={(e) =>
                      setBuilder((b) => ({ ...b, customCron: e.target.value }))
                    }
                  />
                </label>
              )}
            </div>

            <div className={styles.preview}>
              {previewLabel ? (
                <>
                  <span className={styles.previewLabel}>{previewLabel}</span>
                  <code className={styles.previewCron}>{previewCron}</code>
                </>
              ) : (
                <span className={styles.previewInvalid}>
                  {t('scheduledTasks.error.invalidSchedule')}
                </span>
              )}
            </div>

            {formError && <div className={styles.formError}>{formError}</div>}

            <div className={styles.formActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={resetForm}
                disabled={submitting}
              >
                {t('scheduledTasks.cancel')}
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => void handleSubmit()}
                disabled={submitting}
              >
                {submitting
                  ? t(
                      editingId
                        ? 'scheduledTasks.saving'
                        : 'scheduledTasks.creating',
                    )
                  : t(
                      editingId
                        ? 'scheduledTasks.save'
                        : 'scheduledTasks.create',
                    )}
              </button>
            </div>
          </div>
        </DialogShell>
      )}
      {referencePicker}

      {loadError && <div className={styles.loadError}>{loadError}</div>}

      {tasks !== null && tasks.length === 0 && !loadError && (
        <div className={styles.empty}>{t('scheduledTasks.empty')}</div>
      )}

      <div className={styles.list}>
        {(tasks ?? []).map((task) => {
          const title = task.name || task.prompt;
          const busy = busyId === taskKey(task);
          return (
            <div
              key={taskKey(task)}
              className={`${styles.card} ${task.enabled ? '' : styles.cardDisabled}`}
            >
              <div className={styles.cardHeader}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={task.enabled}
                  aria-label={
                    task.enabled
                      ? t('scheduledTasks.disable')
                      : t('scheduledTasks.enable')
                  }
                  className={`${styles.toggle} ${task.enabled ? styles.toggleOn : ''}`}
                  onClick={() => void handleToggle(task)}
                  disabled={busy}
                >
                  <span className={styles.toggleKnob} />
                </button>
                <div className={styles.cardTitle} title={title}>
                  {title}
                </div>
                <div className={styles.cardMenu}>
                  <button
                    type="button"
                    className={styles.iconAction}
                    onClick={() => void handleRunNow(task)}
                    disabled={!task.enabled || runningTaskId !== null}
                    title={t('scheduledTasks.runNow')}
                    aria-label={t('scheduledTasks.runNow')}
                  >
                    ▶
                  </button>
                  <button
                    type="button"
                    className={styles.iconAction}
                    onClick={() => openEdit(task)}
                    disabled={busy}
                    title={t('scheduledTasks.edit')}
                    aria-label={t('scheduledTasks.edit')}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className={styles.iconAction}
                    onClick={() => void handleDelete(task)}
                    disabled={busy}
                    title={t('scheduledTasks.delete')}
                    aria-label={t('scheduledTasks.delete')}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {task.name && (
                <div className={styles.cardPrompt} title={task.prompt}>
                  {task.prompt}
                </div>
              )}

              <div className={styles.cardFooter}>
                {isMultiWorkspace && task.workspaceCwd && (
                  <span
                    className={styles.workspacePill}
                    title={task.workspaceCwd}
                  >
                    <span className={styles.workspaceIcon} aria-hidden="true">
                      ⌂
                    </span>
                    {workspaceBasename(task.workspaceCwd)}
                  </span>
                )}
                <span className={styles.schedulePill}>
                  <span className={styles.clockIcon} aria-hidden="true">
                    ◷
                  </span>
                  {describeCron(task.cron, t)}
                </span>
                <span className={styles.recurringTag}>
                  {t(
                    task.recurring
                      ? 'scheduledTasks.repeats'
                      : 'scheduledTasks.runsOnce',
                  )}
                </span>
                {task.delivery && (
                  <span
                    className={styles.schedulePill}
                    data-testid="scheduled-task-delivery"
                    title={storedDeliveryDescription(task.delivery.target, t)}
                  >
                    {storedDeliveryDescription(task.delivery.target, t)}
                  </span>
                )}
                {task.nextRunAt != null && (
                  <span
                    className={styles.countdown}
                    data-testid="scheduled-task-next-run"
                    title={t('scheduledTasks.nextRunTooltip', {
                      when: safeLocaleString(task.nextRunAt),
                    })}
                  >
                    <span className={styles.hourglassIcon} aria-hidden="true">
                      ⏳
                    </span>
                    {formatCountdown(task.nextRunAt - now, t)}
                  </span>
                )}
                <span className={styles.lastFired}>
                  {describeLastRun(task, t)}
                </span>
                {task.sessionId && onOpenSession ? (
                  // The task's bound session IS its run history — open its
                  // transcript. Always shown (empty state included) so the
                  // history is discoverable even before the first run.
                  <button
                    type="button"
                    className={styles.runsToggle}
                    onClick={() => onOpenSession(task.sessionId!)}
                    title={t('scheduledTasks.viewHistoryHint')}
                  >
                    {task.runs.length > 0
                      ? t('scheduledTasks.viewHistory', {
                          count: task.runs.length,
                        })
                      : t('scheduledTasks.viewHistoryEmpty')}
                  </button>
                ) : (
                  // Unbound (tool-created / legacy) task: no session to open, so
                  // fall back to the inline fire-timestamp list.
                  task.runs.length > 0 && (
                    <button
                      type="button"
                      className={styles.runsToggle}
                      aria-expanded={expandedRunsId === taskKey(task)}
                      onClick={() =>
                        setExpandedRunsId((cur) =>
                          cur === taskKey(task) ? null : taskKey(task),
                        )
                      }
                    >
                      {t('scheduledTasks.runHistory', {
                        count: task.runs.length,
                      })}
                    </button>
                  )
                )}
              </div>

              {expandedRunsId === taskKey(task) && task.runs.length > 0 && (
                <ul className={styles.runsList}>
                  {/* Newest first — the ring is stored oldest-first. */}
                  {[...task.runs].reverse().map((run, idx) => (
                    <li key={`${run.at}-${idx}`} className={styles.runsItem}>
                      {describeRun(run, t)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
