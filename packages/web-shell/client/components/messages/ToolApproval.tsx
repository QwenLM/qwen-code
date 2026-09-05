import {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
  useMemo,
  useId,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { isAgentTool } from '@qwen-code/web-shell/daemon-react-sdk';
import type { PermissionRequest, TodoItem } from '../../adapters/types';
import { useI18n } from '../../i18n';
import { PlanExecutionView } from './PlanExecutionView';
import { isExitPlanApprovalRequest } from '../../utils/todos';
import { getShadowAwareActiveElement, isEditableTarget } from '../../utils/dom';
import { localizeToolDisplayName } from './toolFormatting';
import styles from './ToolApproval.module.css';

interface ToolApprovalProps {
  request: PermissionRequest;
  onConfirm: (id: string, selectedOption: string) => void | Promise<void>;
  variant?: 'inline' | 'floating';
  /**
   * Whether this approval should pull keyboard focus to its safe-default option
   * when it becomes the topmost (visible) one — on appearance, or when a panel/
   * dialog that was covering it closes. Defaults to true. Split-view panes pass
   * false: each pane's approval stays visible side-by-side, so auto-focusing one
   * would steal focus from the pane the user is working in. Keyboard handling
   * itself is focus-scoped (an onKeyDown on the panel), so a keyboardActive=false
   * approval is still fully operable by keyboard once the user tabs/clicks into
   * it — it just never grabs focus on its own.
   */
  keyboardActive?: boolean;
  planTodos?: readonly TodoItem[];
}

export function parseTitle(title?: string): {
  toolName: string;
  description: string;
} {
  if (!title) return { toolName: '', description: '' };
  const colonIdx = title.indexOf(': ');
  if (colonIdx > 0) {
    const prefix = title.slice(0, colonIdx);
    // Only split CLI-style titles such as "Bash: npm test". Descriptive
    // permission titles may contain ordinary prose like "(format: auto)";
    // treating those colons as separators corrupts the header into name/desc.
    if (!/^[A-Za-z][\w.-]{0,40}$/.test(prefix)) {
      return { toolName: title, description: '' };
    }
    return {
      toolName: prefix,
      description: title.slice(colonIdx + 2),
    };
  }
  return { toolName: title, description: '' };
}

function extractContentText(request: PermissionRequest): string {
  const parts: string[] = [];
  for (const block of request.content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function isExecKind(request: PermissionRequest): boolean {
  const toolName = request.toolName?.toLowerCase();
  return (
    request.kind === 'bash' ||
    request.kind === 'exec' ||
    request.kind === 'execute' ||
    request.kind === 'shell' ||
    toolName === 'run_shell_command'
  );
}

function getCommandFromRawInput(request: PermissionRequest): string | null {
  if (!request.rawInput) return null;
  const raw = request.rawInput;
  if (typeof raw.command === 'string') return raw.command;
  if (typeof raw.input === 'string') return raw.input;
  return null;
}

function getDescriptionText(request: PermissionRequest): string | undefined {
  const description = request.rawInput?.description;
  if (typeof description === 'string' && description.trim()) {
    return description.trim();
  }
  return request.title;
}

function getSafeDefaultIndex(
  options: PermissionRequest['options'],
  isAgent = false,
): number {
  if (isAgent) {
    // Launching the agent is the model's proposed next action: default the
    // selection to the one-shot allow instead of the reject button, and never
    // to a permanent allow rule.
    const allowOnceIdx = options.findIndex((o) => o.kind === 'allow_once');
    if (allowOnceIdx >= 0) return allowOnceIdx;
    // No one-shot option: fall back to the reject (safe) rather than landing
    // on a permanent allow rule.
    const rejectIdx = options.findIndex(
      (o) => o.kind === 'reject_once' || o.kind === 'reject_always',
    );
    return rejectIdx >= 0 ? rejectIdx : 0;
  }
  if (
    options.length > 1 &&
    (options[0].kind === 'allow_always' || options[0].kind === 'reject_always')
  ) {
    const saferIdx = options.findIndex(
      (o) => o.kind === 'allow_once' || o.kind === 'reject_once',
    );
    return saferIdx >= 0 ? saferIdx : 1;
  }
  return 0;
}

function getOptionRank(option: PermissionRequest['options'][number]): number {
  if (option.kind === 'reject_once' || option.kind === 'reject_always') {
    return 0;
  }
  if (option.kind === 'allow_always' && option.id === 'proceed_always_user') {
    return 1;
  }
  if (
    option.kind === 'allow_always' &&
    option.id === 'proceed_always_project'
  ) {
    return 2;
  }
  if (
    option.kind === 'allow_always' &&
    (option.id === 'proceed_always_server' ||
      option.id === 'proceed_always_tool')
  ) {
    return 3;
  }
  if (option.kind === 'allow_always') return 3;
  if (option.kind === 'allow_once') return 4;
  return 5;
}

function orderPermissionOptions(
  options: PermissionRequest['options'],
): PermissionRequest['options'] {
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => {
      const rankDelta = getOptionRank(a.option) - getOptionRank(b.option);
      return rankDelta === 0 ? a.index - b.index : rankDelta;
    })
    .map(({ option }) => option);
}

function getOptionI18nKey(
  option: PermissionRequest['options'][number],
): string | undefined {
  if (option.id === 'proceed_once_and_switch_to_default') {
    return 'approval.option.allowOnceAndSwitchToDefault';
  }
  if (option.id === 'restore_previous') {
    return 'approval.option.restorePrevious';
  }
  if (option.kind === 'allow_once') return 'approval.option.allowOnce';
  if (option.kind === 'reject_once') return 'approval.option.rejectOnce';
  if (option.kind === 'allow_always') {
    if (option.id === 'proceed_always_project')
      return 'approval.option.allowAlwaysProject';
    if (option.id === 'proceed_always_user')
      return 'approval.option.allowAlwaysUser';
    if (option.id === 'proceed_always_server')
      return 'approval.option.allowAlwaysServer';
    if (option.id === 'proceed_always_tool')
      return 'approval.option.allowAlwaysTool';
    if (option.id === 'proceed_always') return 'approval.option.allowAllEdits';
  }
  return undefined;
}

// Production producers (toPermissionOptions) emit distinct ids, so this
// rarely fires; it guards the key={option.id} React duplicate-key warning
// if a producer ever repeats an id.
function deduplicateOptions(
  options: PermissionRequest['options'],
): PermissionRequest['options'] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.id)) return false;
    seen.add(option.id);
    return true;
  });
}

function prepareDisplayOptions(
  options: PermissionRequest['options'],
): PermissionRequest['options'] {
  return deduplicateOptions(orderPermissionOptions(options));
}

function getOptionClassName(
  option: PermissionRequest['options'][number],
): string {
  if (option.kind === 'allow_once') return styles.optionPrimary;
  if (option.kind === 'allow_always') return styles.optionSecondary;
  if (option.kind === 'reject_once' || option.kind === 'reject_always') {
    return styles.optionPlain;
  }
  return styles.optionSecondary;
}

export function ToolApproval({
  request,
  onConfirm,
  variant = 'inline',
  keyboardActive = true,
  planTodos = [],
}: ToolApprovalProps) {
  const { t } = useI18n();
  const isAgent = isAgentTool(request.toolName);
  const displayOptions = useMemo(
    () => prepareDisplayOptions(request.options),
    [request.options],
  );
  const isExitPlanApproval = isExitPlanApprovalRequest(request);
  const showsPlanWorkflow = planTodos.length > 0 && isExitPlanApproval;
  const safeDefaultIndex = useMemo(
    () => getSafeDefaultIndex(displayOptions, isAgent),
    [displayOptions, isAgent],
  );
  // Prefer the localized label. Known producers give every option a distinct
  // i18n key (plan mode's restore_previous has its own), so this normally
  // localizes everything. The key count is a last-resort guard: if a future
  // producer repeats a generic key, those options fall back to the server's
  // distinct labels instead of identical buttons. An empty server label still
  // degrades to the localized text, never a blank button without an accessible
  // name.
  const labelForOption = useMemo(() => {
    const keyCount = new Map<string, number>();
    for (const option of displayOptions) {
      const key = getOptionI18nKey(option);
      if (key) keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
    }
    return (option: PermissionRequest['options'][number]) => {
      if (showsPlanWorkflow) {
        // An exit_plan_mode approval emits two `allow_once` options, so this
        // cannot relabel by kind alone: `restore_previous` restores the
        // pre-plan approval mode (YOLO if the user entered plan from YOLO)
        // while the plain confirm keeps manual approval. Sharing one label
        // would hide that difference behind two identical buttons.
        if (
          option.kind === 'allow_once' &&
          option.id !== 'restore_previous' &&
          option.id !== 'proceed_once_and_switch_to_default'
        ) {
          return t('workflow.planReview.confirm');
        }
        if (option.kind === 'reject_once' || option.kind === 'reject_always') {
          return t('workflow.planReview.continuePlanning');
        }
      }
      const key = getOptionI18nKey(option);
      if (key && keyCount.get(key) === 1) return t(key);
      return option.label || (key ? t(key) : '');
    };
  }, [displayOptions, showsPlanWorkflow, t]);
  const [selected, setSelected] = useState(safeDefaultIndex);
  const requestRef = useRef(request);
  requestRef.current = request;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const submittedRef = useRef(false);
  const safeDefaultIndexRef = useRef(safeDefaultIndex);
  safeDefaultIndexRef.current = safeDefaultIndex;
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  const questionId = useId();
  const descId = useId();
  const commandId = useId();

  // Reset only when a NEW request arrives. Reading the safe default through a
  // ref keeps this keyed strictly to request identity: if the same request's
  // options (and thus its safe default) change mid-flight, re-running the
  // effect would clear submittedRef and re-enable a second confirm for a
  // request the user already answered.
  useEffect(() => {
    submittedRef.current = false;
    selectedRef.current = safeDefaultIndexRef.current;
    setSelected(safeDefaultIndexRef.current);
  }, [request.id]);

  const parsedTitle = parseTitle(request.title);
  const rawToolName =
    request.toolName || parsedTitle.toolName || request.kind || 'Tool';
  const toolName = showsPlanWorkflow
    ? t('workflow.planReview.title')
    : localizeToolDisplayName(rawToolName, t);
  const descriptionText = showsPlanWorkflow
    ? undefined
    : getDescriptionText(request);
  const contentText = extractContentText(request);

  const confirm = useCallback(
    (optionId: string) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      const requestId = requestRef.current.id;
      const submission = onConfirm(requestId, optionId);
      if (submission) {
        void submission.catch(() => {
          // Re-arm only if the rejected submission still belongs to the
          // current request. This instance is reused across successive
          // requests (no key at the mount sites), and a submission can
          // reject late (up to the action timeout); a stale rejection would
          // otherwise disarm the successor's double-submit guard mid-flight.
          if (requestRef.current.id === requestId) {
            submittedRef.current = false;
          }
        });
      }
    },
    [onConfirm],
  );

  const focusOption = useCallback((index: number) => {
    const target = optionRefs.current[index];
    if (!target) return;
    // A bare .focus() is a no-op when the option already has focus, so a new
    // request that lands on the same index wouldn't re-announce for screen
    // readers. Blur first to force a re-focus indication in that edge case.
    if (document.activeElement === target) target.blur();
    target.focus();
  }, []);

  // Pull focus to the safe-default option when this approval becomes the
  // topmost one — on appearance (false→true) or when a new request arrives
  // while already active. Initializing the prev flag to false makes the first
  // mount with keyboardActive=true count as a transition, so an approval that is
  // already topmost on mount still focuses its default.
  const prevKeyboardActiveRef = useRef(false);
  const prevRequestIdRef = useRef(request.id);
  // Must be a layout effect, not a passive one: the commit that mounts this
  // overlay also hides the composer, and sibling layout effects can force a
  // synchronous style recalculation (by reading layout) before any passive
  // effect runs — Chromium drops focus from the just-hidden composer during
  // that recalculation, so a passive guard would read `body` and miss.
  // Layout effects run right after DOM mutation, before any recalculation,
  // while the hidden composer still holds focus.
  useLayoutEffect(() => {
    const wasActive = prevKeyboardActiveRef.current;
    const prevRequestId = prevRequestIdRef.current;
    prevKeyboardActiveRef.current = keyboardActive;
    prevRequestIdRef.current = request.id;
    if (!keyboardActive) return;
    const requestChanged = request.id !== prevRequestId;
    if (wasActive && !requestChanged) return;
    // The approval can appear while the user is mid-typing in the composer:
    // the same commit hides the composer and mounts this overlay. Grabbing
    // focus would redirect the in-progress keystrokes — Enter-to-send, Space,
    // digits — to the safe-default option and can confirm the request
    // unintentionally. Yield to the editable target; the dialog stays
    // reachable by Tab/click.
    if (isEditableTarget(getShadowAwareActiveElement(panelRef.current))) {
      return;
    }
    // Fresh request → safe default; same request re-activated (e.g. a covering
    // panel closed) → restore the option the user had selected rather than
    // snapping focus back to the default and silently changing their choice.
    focusOption(requestChanged ? safeDefaultIndex : selectedRef.current);
  }, [keyboardActive, request.id, focusOption, safeDefaultIndex]);

  const moveSelection = useCallback(
    (delta: number) => {
      const count = displayOptions.length;
      // Compute from the ref (kept in sync) so rapid key repeats advance
      // correctly even before React re-renders, and keep the state updater pure
      // (no focus() side effect inside it).
      const next = (selectedRef.current + delta + count) % count;
      selectedRef.current = next;
      setSelected(next);
      focusOption(next);
    },
    [displayOptions.length, focusOption],
  );

  // Keyboard handling is scoped to the panel (onKeyDown), so it only fires while
  // focus is inside this approval — a keypress can never confirm a different
  // pane's request. Arrow/j/k move focus (roving tabindex); Enter/Space confirm
  // the focused option natively; digits confirm by position; Escape rejects.
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        e.key !== 'Escape' &&
        e.target instanceof Element &&
        e.target.closest('[data-plan-interactive]')
      ) {
        return;
      }
      const count = displayOptions.length;
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        moveSelection(-1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        selectedRef.current = 0;
        setSelected(0);
        focusOption(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        const last = count - 1;
        selectedRef.current = last;
        setSelected(last);
        focusOption(last);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        const reject = requestRef.current.options.find(
          (o) => o.kind === 'reject_once' || o.kind === 'reject_always',
        );
        if (reject) confirm(reject.id);
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < count) {
          e.preventDefault();
          confirm(displayOptions[idx].id);
        }
      }
    },
    [displayOptions, moveSelection, confirm, focusOption],
  );

  const isExec = isExecKind(request);
  const command = getCommandFromRawInput(request);
  const showsCommandBlock = Boolean(
    (isExec && command) || (contentText && contentText !== request.title),
  );
  const questionText = showsPlanWorkflow
    ? t('workflow.planReview.question')
    : isAgent
      ? t('approval.launchAgentQuestion')
      : isExec
        ? t('approval.execQuestion', { tool: toolName })
        : t('approval.changeQuestion');

  return (
    <div
      ref={panelRef}
      className={
        variant === 'floating'
          ? `${styles.approval} ${styles.floating}${
              showsPlanWorkflow ? ` ${styles.floatingWorkflow}` : ''
            }`
          : styles.approval
      }
      data-web-shell-permission-panel
      role="alertdialog"
      aria-labelledby={headingId}
      // Expose the question, the tool description, and the command/content to
      // assistive tech — SR users must hear WHAT will run (e.g. `rm -rf …`), not
      // just "Allow run_shell_command?", before confirming. Only reference ids
      // whose elements actually render, so there are no dangling ARIA IDREFs
      // (axe-core aria-valid-attr-value) when description/command are absent.
      aria-describedby={[
        questionId,
        descriptionText ? descId : null,
        showsCommandBlock ? commandId : null,
      ]
        .filter(Boolean)
        .join(' ')}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          ?
        </span>
        <span className={styles.name} id={headingId}>
          {toolName}
        </span>
      </div>

      {descriptionText && (
        <div className={styles.desc} id={descId} title={descriptionText}>
          {descriptionText}
        </div>
      )}

      {isExec && command ? (
        <div className={styles.code}>
          <pre className={styles.codeBlock} id={commandId} title={command}>
            {command}
          </pre>
        </div>
      ) : contentText && contentText !== request.title ? (
        <pre
          className={`${styles.content}${
            isExitPlanApproval ? ` ${styles.planContent}` : ''
          }`}
          id={commandId}
          title={contentText}
        >
          {contentText}
        </pre>
      ) : null}

      {showsPlanWorkflow && (
        <div className={styles.workflow}>
          <PlanExecutionView todos={planTodos} tools={[]} tasks={[]} />
        </div>
      )}

      <div className={styles.question} id={questionId}>
        {questionText}
      </div>

      {/* radiogroup semantics — the approval choice is single-select. No label
          on the group: the alertdialog already exposes the question via
          aria-describedby, so labelling the container with the same text would
          make screen readers speak the question twice. */}
      <div className={styles.options} role="radiogroup">
        {displayOptions.map((option, i) => {
          const isSelected = i === selected;
          const label = labelForOption(option);
          return (
            <button
              key={option.id}
              type="button"
              ref={(el) => {
                optionRefs.current[i] = el;
              }}
              className={`${styles.option} ${getOptionClassName(option)} ${
                isSelected ? styles.optionActive : ''
              }`}
              data-web-shell-permission-option
              data-option-id={option.id}
              tabIndex={isSelected ? 0 : -1}
              role="radio"
              aria-checked={isSelected}
              aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
              onClick={() => confirm(option.id)}
              onFocus={() => {
                selectedRef.current = i;
                setSelected(i);
              }}
            >
              <span className={styles.pointer} aria-hidden="true">
                {isSelected ? '›' : ' '}
              </span>
              <span className={styles.num} aria-hidden="true">
                {i + 1}.
              </span>
              <span className={styles.label} data-web-shell-option-label>
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
