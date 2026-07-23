import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useId,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { isAgentTool } from '@qwen-code/webui/daemon-react-sdk';
import type { PermissionRequest, TodoItem } from '../../adapters/types';
import { useI18n } from '../../i18n';
import { PlanExecutionView } from './PlanExecutionView';
import { localizeToolDisplayName } from './toolFormatting';
import styles from './ToolApproval.module.css';

interface ToolApprovalProps {
  request: PermissionRequest;
  onConfirm: (id: string, selectedOption: string) => void;
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

function getSafeDefaultIndex(options: PermissionRequest['options']): number {
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
  const displayOptions = useMemo(
    () => orderPermissionOptions(request.options),
    [request.options],
  );
  const [selected, setSelected] = useState(() =>
    getSafeDefaultIndex(orderPermissionOptions(request.options)),
  );
  const requestRef = useRef(request);
  requestRef.current = request;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const submittedRef = useRef(false);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const headingId = useId();
  const questionId = useId();
  const descId = useId();
  const commandId = useId();

  useEffect(() => {
    const safeDefaultIndex = getSafeDefaultIndex(
      orderPermissionOptions(requestRef.current.options),
    );
    submittedRef.current = false;
    selectedRef.current = safeDefaultIndex;
    setSelected(safeDefaultIndex);
  }, [request.id]);

  const parsedTitle = parseTitle(request.title);
  const rawToolName =
    request.toolName || parsedTitle.toolName || request.kind || 'Tool';
  const toolName = localizeToolDisplayName(rawToolName, t);
  const descriptionText = getDescriptionText(request);
  const contentText = extractContentText(request);

  const confirm = useCallback(
    (optionId: string) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      onConfirm(requestRef.current.id, optionId);
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
  useEffect(() => {
    const wasActive = prevKeyboardActiveRef.current;
    const prevRequestId = prevRequestIdRef.current;
    prevKeyboardActiveRef.current = keyboardActive;
    prevRequestIdRef.current = request.id;
    if (!keyboardActive) return;
    const requestChanged = request.id !== prevRequestId;
    if (wasActive && !requestChanged) return;
    // Fresh request → safe default; same request re-activated (e.g. a covering
    // panel closed) → restore the option the user had selected rather than
    // snapping focus back to the default and silently changing their choice.
    focusOption(
      requestChanged
        ? getSafeDefaultIndex(
            orderPermissionOptions(requestRef.current.options),
          )
        : selectedRef.current,
    );
  }, [keyboardActive, request.id, focusOption]);

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
  const isAgent = isAgentTool(request.toolName);
  const command = getCommandFromRawInput(request);
  const showsCommandBlock = Boolean(
    (isExec && command) || (contentText && contentText !== request.title),
  );
  const isExitPlanApproval =
    request.toolKind === 'switch_mode' &&
    request.toolName?.toLowerCase() === 'exit_plan_mode';
  const showsPlanWorkflow = planTodos.length > 0 && isExitPlanApproval;
  const questionText = isAgent
    ? t('approval.launchAgentQuestion')
    : isExec
      ? t('approval.execQuestion', { tool: toolName })
      : t('approval.changeQuestion');

  return (
    <div
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
          const i18nKey = getOptionI18nKey(option);
          const label = i18nKey ? t(i18nKey) : option.label;
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
              <span className={styles.label}>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
