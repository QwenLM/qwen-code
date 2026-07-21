import {
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  ACPToolCall,
  PermissionRequest,
  TodoItem,
} from '../../adapters/types';
import { isSubAgentToolCall } from '../../adapters/toolClassification';
// Circular import with SubAgentPanel (its SubToolLine renders ToolLine
// from this module). Safe only while both modules dereference each
// other's exports at render time — never in top-level code.
import { SubAgentPanel } from './tools/SubAgentPanel';
import { DiffView } from './tools/DiffView';
import { parseAnsi, hasAnsi } from '../../utils/ansi';
import {
  extractTodosFromToolCall,
  isTodoWriteToolName,
} from '../../utils/todos';
import { useSharedNow } from '../../hooks/useSharedNow';
import { useSubagentDetails } from '../../subagentDetailsContext';
import { TodoEventSummary, TodoFullList } from './TodoView';
import { Markdown } from './Markdown';
import {
  formatDurationMs,
  formatElapsed,
  formatLiveElapsed,
  localizeToolDisplayName,
  StatusIcon,
  truncateText,
} from './tools/toolDisplay';
import {
  extractText,
  formatTokenCount,
  getAgentCancellationReason,
  getAgentDescription,
  getAgentDisplayStatus,
  getAgentType,
  getTaskExecutionRecord,
  getShellToolSemanticDescription,
  getToolDescription,
  getToolSummaryDescription,
  getToolResultSummary,
  isAskUserQuestionToolName,
  isSkillToolName,
  isShellToolName,
  toolContainsCallId,
} from './toolFormatting';
import { useI18n } from '../../i18n';
import { useTranscriptRenderMode } from '../../transcriptRenderMode';
import { CompactModeContext, TodoTimelineContext } from '../../App';
import {
  type ToolHeaderExtraRenderInfo,
  type ToolHeaderKind,
  useWebShellCustomization,
} from '../../customization';
import flashStyles from '../MessageLocateFlash.module.css';
import styles from './tools/ToolChrome.module.css';

interface ToolGroupProps {
  tools: ACPToolCall[];
  pendingApproval?: PermissionRequest | null;
  workspaceCwd?: string;
  isLocateFlashing?: boolean;
}

export function hasExpandableContent(tool: ACPToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  if (isAskUserQuestionToolName(tool.toolName)) return !!extractText(tool);
  // write_file shows content from args even before completion
  if (name === 'write_file' || name === 'writefile') {
    return !!getWriteContent(tool) || hasEditContent(tool);
  }
  if (tool.status !== 'completed' && tool.status !== 'failed') return false;
  if (isShellToolName(name)) {
    const text = extractText(tool);
    return !!text && text.trim().length > 0 && text.split('\n').length > 1;
  }
  if (isSkillToolName(name)) {
    return !!getFirstToolContentText(tool);
  }
  if (name === 'edit' || name === 'write' || name === 'editfile') {
    return hasEditContent(tool);
  }
  if (name === 'read' || name === 'read_file' || name === 'readfile') {
    const text = extractText(tool);
    return !!text && text.split('\n').length > 3;
  }
  return false;
}

// Tools whose expanded row renders a kind-specific detail view (shell output /
// diff / file content / Q&A). Must stay in sync with the renderers in
// ToolLine's lineDetail block below. Tools NOT in this set have nothing extra
// to show when expanded, so they keep their one-line result summary instead of
// hiding it behind an empty detail area.
function hasDetailView(tool: ACPToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  return (
    isShellToolName(name) ||
    name === 'write_file' ||
    name === 'writefile' ||
    name === 'edit' ||
    name === 'write' ||
    name === 'editfile' ||
    name === 'read' ||
    name === 'read_file' ||
    name === 'readfile' ||
    isSkillToolName(name) ||
    isAskUserQuestionToolName(tool.toolName)
  );
}

function hasDiffContent(tool: ACPToolCall): boolean {
  if (tool.content?.some((b) => b.type === 'diff')) return true;
  return !!getRawFileDiff(tool);
}

function hasEditContent(tool: ACPToolCall): boolean {
  return hasDiffContent(tool) || !!extractText(tool);
}

export function extractDiff(tool: ACPToolCall): string {
  const rawFileDiff = getRawFileDiff(tool);
  if (rawFileDiff) return rawFileDiff;

  if (tool.content) {
    const diffBlock = tool.content.find((b) => b.type === 'diff');
    if (diffBlock && diffBlock.type === 'diff') {
      return buildUnifiedDiff(diffBlock.oldText || '', diffBlock.newText || '');
    }
  }

  return '';
}

export function getRawFileDiff(tool: ACPToolCall): string {
  if (tool.rawOutput && typeof tool.rawOutput === 'object') {
    const raw = tool.rawOutput as Record<string, unknown>;
    if (isTruncatedSessionDiff(raw)) return '';
    if (typeof raw.fileDiff === 'string') return raw.fileDiff;
  }
  return '';
}

function isTruncatedSessionDiff(raw: Record<string, unknown>): boolean {
  return (
    raw.truncatedForSession === true && 'fileName' in raw && 'newContent' in raw
  );
}

const MAX_DIFF_PRODUCT = 250_000;

export function buildUnifiedDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const n = oldLines.length;
  const m = newLines.length;

  if (n * m > MAX_DIFF_PRODUCT) {
    const removed = oldLines.map((l) => (l ? `-${l}` : '-'));
    const added = newLines.map((l) => (l ? `+${l}` : '+'));
    return [...removed, ...added].join('\n');
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result: string[] = [];
  let i = n,
    j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push(` ${oldLines[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push(`+${newLines[j - 1]}`);
      j--;
    } else {
      result.push(`-${oldLines[i - 1]}`);
      i--;
    }
  }

  return result.reverse().join('\n');
}

// A description longer than this is likely ellipsised on a normal-width row, so
// the row becomes expandable to re-flow the full text into a wrapped block.
const DESCRIPTION_EXPAND_THRESHOLD = 60;
const MAX_MARKDOWN_READ_CHARS = 200_000;
const MAX_MARKDOWN_READ_LINES = 1000;
const READ_LANGUAGE_ALIASES: Record<string, string> = {
  cjs: 'javascript',
  cts: 'typescript',
  h: 'c',
  hpp: 'cpp',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  mts: 'typescript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  ts: 'typescript',
  tsx: 'tsx',
  yml: 'yaml',
};

function ExpandedBashOutput({ tool }: { tool: ACPToolCall }) {
  const output = useMemo(() => extractText(tool) || '', [tool]);
  const ansiSegments = useMemo(
    () => (hasAnsi(output) ? parseAnsi(output) : null),
    [output],
  );

  return (
    <div className={styles.expandedBash}>
      <pre className={styles.expandedOutput}>
        {ansiSegments
          ? ansiSegments.map((seg, i) => (
              <span
                key={i}
                style={{
                  color: seg.color,
                  fontWeight: seg.bold ? 'bold' : undefined,
                  opacity: seg.dim ? 0.6 : undefined,
                }}
              >
                {seg.text}
              </span>
            ))
          : output}
      </pre>
    </div>
  );
}

function ExpandedReadContent({ tool }: { tool: ACPToolCall }) {
  const content = useMemo(() => extractText(tool) || '', [tool]);
  const language = languageForPath(getReadFilePath(tool));
  const plainText =
    language === 'text' ||
    content.length > MAX_MARKDOWN_READ_CHARS ||
    exceedsLineLimit(content, MAX_MARKDOWN_READ_LINES);

  return (
    <div className={styles.expandedRead}>
      {plainText ? (
        <pre className={styles.expandedOutput}>{content}</pre>
      ) : (
        <Markdown content={fencedCodeBlock(language, content)} />
      )}
    </div>
  );
}

function getReadFilePath(tool: ACPToolCall): string {
  const filePath = tool.args?.file_path ?? tool.args?.path;
  return typeof filePath === 'string' ? filePath : '';
}

function exceedsLineLimit(text: string, maxLines: number): boolean {
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++lines > maxLines) return true;
  }
  return false;
}

export function languageForPath(filePath: string): string {
  const ext = filePath.split(/[?#]/, 1)[0]?.split('.').pop()?.toLowerCase();
  if (!ext || ext === filePath.toLowerCase()) return 'text';
  if (ext === 'mermaid' || ext === 'mmd') return 'text';
  const language = READ_LANGUAGE_ALIASES[ext] ?? ext;
  return /^[\w+.#-]+$/.test(language) ? language : 'text';
}

export function fencedCodeBlock(language: string, code: string): string {
  const longestFence =
    code
      .match(/~{3,}/g)
      ?.reduce((max, fence) => Math.max(max, fence.length), 0) ?? 0;
  const fence = '~'.repeat(Math.max(3, longestFence + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

function ExpandedEditContent({ tool }: { tool: ACPToolCall }) {
  const diff = useMemo(() => extractDiff(tool), [tool]);
  const text = useMemo(() => extractText(tool) || '', [tool]);
  if (!diff && !text) return null;
  return (
    <div className={styles.expandedEdit}>
      {diff ? (
        <DiffView diff={diff} />
      ) : (
        <pre className={styles.expandedOutput}>{text}</pre>
      )}
    </div>
  );
}

function ToolExpandedCard({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <div className={styles.expandedCard}>
      <div className={styles.expandedCardHeader}>
        <span className={styles.expandedCardTitle}>{title}</span>
        {detail && <span className={styles.expandedCardDetail}>{detail}</span>}
      </div>
      {children && <div className={styles.expandedCardBody}>{children}</div>}
    </div>
  );
}

function getWriteContent(tool: ACPToolCall): string {
  if (tool.args?.content) return tool.args.content as string;
  if (tool.args?.new_string) return tool.args.new_string as string;
  const text = extractText(tool);
  if (text) return text;
  if (tool.rawOutput && typeof tool.rawOutput === 'object') {
    const raw = tool.rawOutput as Record<string, unknown>;
    if (typeof raw.content === 'string') return raw.content;
    if (typeof raw.newContent === 'string') return raw.newContent;
  }
  return '';
}

// Collapsed by default: the diff of this todo_write call (just-completed and
// just-started items), expanding to the full list on click. The per-snapshot
// diff comes from the timeline context, so this is isolated in its own
// component — only todo rows subscribe and re-render when the timeline changes,
// not every tool row.
function TodoToolBody({
  tool,
  todos,
  expanded,
  title,
}: {
  tool: ACPToolCall;
  todos: TodoItem[];
  expanded: boolean;
  title: string;
}) {
  const timeline = useContext(TodoTimelineContext);
  const events = timeline.get(tool.callId)?.events ?? [];
  return expanded ? (
    <ToolExpandedCard title={title}>
      <div className={styles.todoBody}>
        <TodoFullList todos={todos} />
      </div>
    </ToolExpandedCard>
  ) : (
    <div className={styles.todoBody}>
      <TodoEventSummary todos={todos} events={events} />
    </div>
  );
}

interface ToolLineProps {
  tool: ACPToolCall;
  approval?: PermissionRequest | null;
  workspaceCwd?: string;
  summaryOnly?: boolean;
  forceExpanded?: boolean;
  forceExpandable?: boolean;
  hideHeader?: boolean;
  hideCollapsedOutput?: boolean;
}

function getAgentDisplayInfo(
  tool: ACPToolCall,
  now?: number,
): {
  agentType: string;
  explicitAgentType: string;
  description: string;
  subToolCount: number;
  elapsed: string;
  tokens: string;
  status: ACPToolCall['status'];
  reason: string;
} {
  const taskExec = getTaskExecutionRecord(tool.rawOutput);
  const reason = getAgentCancellationReason(tool);
  const status = getAgentDisplayStatus(tool);
  const agentType = getAgentType(tool);
  const explicitAgentType = getExplicitAgentType(tool);
  const description = getAgentDescription(tool);

  const subToolCount =
    tool.subTools?.length ||
    (taskExec?.['toolCalls'] as unknown[] | undefined)?.length ||
    0;

  const stats = taskExec?.['executionSummary'] as
    | Record<string, unknown>
    | undefined;
  const elapsed =
    stats && typeof stats['totalDurationMs'] === 'number'
      ? formatDurationMs(stats['totalDurationMs'])
      : formatElapsed(
          tool.startTime,
          tool.endTime ??
            (tool.status === 'in_progress' && now ? now : undefined),
        );

  const outputTokens =
    taskExec &&
    typeof taskExec['tokenCount'] === 'number' &&
    taskExec['tokenCount'] > 0
      ? (taskExec['tokenCount'] as number)
      : stats &&
          typeof stats['outputTokens'] === 'number' &&
          stats['outputTokens'] > 0
        ? (stats['outputTokens'] as number)
        : 0;
  const tokens = outputTokens > 0 ? formatTokenCount(outputTokens) : '';

  return {
    agentType,
    explicitAgentType,
    description,
    subToolCount,
    elapsed,
    tokens,
    status,
    reason,
  };
}

function getExplicitAgentType(tool: ACPToolCall): string {
  const taskExec = getTaskExecutionRecord(tool.rawOutput);
  const name = taskExec?.['subagentName'];
  if (typeof name === 'string' && name.trim()) return name.trim();
  const subagentType = tool.args?.subagent_type;
  if (typeof subagentType === 'string' && subagentType.trim()) {
    return subagentType.trim();
  }
  return '';
}

export function shouldAutoExpand(tool: ACPToolCall): boolean {
  // Only the verbose tool kinds below (shell/edit/write/ask) auto-expand, and
  // only while pending/in-progress or after failing: a successful completion
  // collapses them to a one-line summary so the transcript stays scannable
  // (click to reopen), while a failure of those kinds stays expanded so its
  // error output is visible without a click. Every other tool kind is collapsed
  // by default regardless of status — its summary line already shows the
  // outcome and it stays click-to-expand.
  if (tool.status === 'completed') return false;
  const name = tool.toolName.toLowerCase();
  if (isAskUserQuestionToolName(tool.toolName)) return true;
  if (name === 'write_file' || name === 'writefile') return true;
  if (name === 'edit' || name === 'editfile') return true;
  if (isShellToolName(name)) return true;
  return false;
}

function ExpandedAskUserQuestionOutput({ tool }: { tool: ACPToolCall }) {
  const text = extractText(tool) || '';
  return <pre className={styles.expandedOutput}>{text}</pre>;
}

function ExpandedSkillOutput({ tool }: { tool: ACPToolCall }) {
  const content =
    getFirstToolContentText(tool) ||
    (typeof tool.args?.args === 'string' && tool.args.args.trim()
      ? tool.args.args.trim()
      : (tool.title ?? ''));

  return <pre className={styles.expandedOutput}>{content}</pre>;
}

function getFirstToolContentText(tool: ACPToolCall): string {
  const block = tool.content?.[0];
  if (block?.type !== 'content') return '';
  return typeof block.content?.text === 'string' ? block.content.text : '';
}

export function getToolHeaderKind(tool: ACPToolCall): ToolHeaderKind {
  const name = tool.toolName.toLowerCase();
  if (isSubAgentToolCall(tool)) return 'agent';
  if (isAskUserQuestionToolName(tool.toolName)) return 'ask';
  if (isShellToolName(name)) return 'shell';
  if (isWebFetchToolName(name)) return 'fetch';
  if (isTodoWriteToolName(name)) return 'todo';
  if (name === 'read' || name === 'read_file' || name === 'readfile')
    return 'read';
  if (name === 'edit' || name === 'editfile') return 'edit';
  if (name === 'write' || name === 'write_file' || name === 'writefile')
    return 'write';
  return 'other';
}

function DefaultToolHeaderExtra({
  description,
  elapsed,
}: {
  description: string;
  elapsed: string;
}) {
  return (
    <>
      {description && <span className={styles.lineArg}>{description}</span>}
      {elapsed && <span className={styles.lineElapsed}>{elapsed}</span>}
    </>
  );
}

function ToolHeaderExtra({ info }: { info: ToolHeaderExtraRenderInfo }) {
  const { renderToolHeaderExtra } = useWebShellCustomization();
  const customExtra = renderToolHeaderExtra?.(info);
  if (customExtra) return <>{customExtra}</>;
  return (
    <DefaultToolHeaderExtra
      description={info.description}
      elapsed={info.elapsed}
    />
  );
}

function isDescriptionExpandable(description: string): boolean {
  return (
    description.length > DESCRIPTION_EXPAND_THRESHOLD ||
    description.includes('\n')
  );
}

export function isActiveToolStatus(
  status: ACPToolCall['status'] | string,
): boolean {
  return (
    status === 'in_progress' || status === 'pending' || status === 'running'
  );
}

export function getActiveTool(tools: ACPToolCall[]): ACPToolCall {
  return (
    tools.find((tool) => isActiveToolStatus(tool.status)) ??
    tools[tools.length - 1]
  );
}

export function formatToolGroupSummary(
  tools: ACPToolCall[],
  t: ReturnType<typeof useI18n>['t'],
  duration?: string,
): string {
  if (hasActiveTool(tools)) {
    const activeTool = getActiveTool(tools);
    if (isAskUserQuestionToolName(activeTool.toolName)) {
      return t('toolGroup.summary.provideInformation');
    }
    return t('toolGroup.running', {
      name: localizeToolDisplayName(activeTool.toolName, t),
      count: tools.length,
      duration: duration ?? '',
    });
  }

  const summary = formatCompletedToolSummary(tools, t);
  if (summary) return summary;

  return t('toolGroup.summary', {
    count: tools.length,
  });
}

export function formatSingleToolSummary(
  tool: ACPToolCall,
  t: ReturnType<typeof useI18n>['t'],
  workspaceCwd?: string,
): string {
  if (isTodoWriteToolName(tool.toolName)) {
    return t('toolGroup.summary.updatedTodos', { count: 1 });
  }
  if (isAskUserQuestionToolName(tool.toolName)) {
    return isActiveToolStatus(tool.status)
      ? t('toolGroup.summary.provideInformation')
      : t('toolGroup.summary.askedQuestions', {
          count: getAskUserQuestionCount(tool),
        });
  }

  const { displayName, description, hideDisplayName } =
    getSingleToolSummaryInfo(tool, t, workspaceCwd);
  return [hideDisplayName ? '' : displayName, description]
    .filter(Boolean)
    .join(' ');
}

function getSingleToolSummaryInfo(
  tool: ACPToolCall,
  t: ReturnType<typeof useI18n>['t'],
  workspaceCwd?: string,
): ToolHeaderExtraRenderInfo & { hideDisplayName: boolean } {
  const displayName = localizeToolDisplayName(tool.toolName, t);
  const description = truncateText(
    getToolSummaryDescription(tool, workspaceCwd),
    120,
  );
  return {
    kind: getToolHeaderKind(tool),
    tool,
    displayName,
    description,
    elapsed: '',
    workspaceCwd,
    hideDisplayName: !!getShellToolSemanticDescription(tool),
  };
}

function SingleToolSummary({
  tool,
  runningDuration,
  workspaceCwd,
}: {
  tool: ACPToolCall;
  runningDuration?: string;
  workspaceCwd?: string;
}) {
  const { t } = useI18n();
  const isAskUserQuestion = isAskUserQuestionToolName(tool.toolName);
  const runningPrefix =
    !isAskUserQuestion &&
    isActiveToolStatus(tool.status) &&
    t('toolGroup.runningPrefix').trim();

  if (isTodoWriteToolName(tool.toolName) || isAskUserQuestion) {
    return (
      <>
        {runningPrefix && <span>{runningPrefix} </span>}
        {formatSingleToolSummary(tool, t, workspaceCwd)}
        {runningDuration && <span> {runningDuration}</span>}
      </>
    );
  }

  const info = getSingleToolSummaryInfo(tool, t, workspaceCwd);

  return (
    <>
      {runningPrefix && <span>{runningPrefix} </span>}
      <span className={styles.chatSummaryInline}>
        {!info.hideDisplayName && (
          <span className={styles.lineName}>{info.displayName}</span>
        )}
        <ToolHeaderExtra info={info} />
      </span>
      {runningDuration && <span> {runningDuration}</span>}
    </>
  );
}

function formatCompletedToolSummary(
  tools: ACPToolCall[],
  t: ReturnType<typeof useI18n>['t'],
): string {
  let edited = 0;
  let commands = 0;
  let read = 0;
  let searched = 0;
  let todos = 0;
  let askedQuestions = 0;
  let other = 0;

  for (const tool of tools) {
    const name = tool.toolName.toLowerCase();
    if (isShellToolName(name)) {
      commands++;
    } else if (
      name === 'edit' ||
      name === 'editfile' ||
      name === 'write' ||
      name === 'write_file' ||
      name === 'writefile'
    ) {
      edited++;
    } else if (name === 'read' || name === 'read_file' || name === 'readfile') {
      read++;
    } else if (
      name === 'grep' ||
      name === 'grep_search' ||
      name === 'search' ||
      name === 'glob' ||
      name === 'web_search' ||
      name === 'websearch'
    ) {
      searched++;
    } else if (isTodoWriteToolName(name)) {
      todos++;
    } else if (isAskUserQuestionToolName(name)) {
      askedQuestions += getAskUserQuestionCount(tool);
    } else {
      other++;
    }
  }

  const parts = [
    edited ? t('toolGroup.summary.editedFiles', { count: edited }) : '',
    commands ? t('toolGroup.summary.ranCommands', { count: commands }) : '',
    read ? t('toolGroup.summary.readFiles', { count: read }) : '',
    searched ? t('toolGroup.summary.searched', { count: searched }) : '',
    todos ? t('toolGroup.summary.updatedTodos', { count: todos }) : '',
    askedQuestions
      ? t('toolGroup.summary.askedQuestions', { count: askedQuestions })
      : '',
    other ? t('toolGroup.summary.otherTools', { count: other }) : '',
  ].filter(Boolean);

  return parts.join(' ');
}

function getAskUserQuestionCount(tool: ACPToolCall): number {
  const questions = tool.args?.questions;
  return Array.isArray(questions) && questions.length > 0
    ? questions.length
    : 1;
}

export function hasActiveTool(tools: ACPToolCall[]): boolean {
  return tools.some((tool) => isActiveToolStatus(tool.status));
}

function PencilIcon() {
  return (
    <svg
      className={styles.chatSummaryToolIcon}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function ToolGroupIcon() {
  return (
    <svg
      className={styles.chatSummaryToolIcon}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      data-testid="chat-summary-tool-icon"
      aria-hidden="true"
    >
      <rect
        x="2"
        y="2"
        width="10"
        height="10"
        rx="2.4"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M4.6 5.2 6 6.6 4.6 8"
        stroke="currentColor"
        strokeWidth="1.05"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.3 8.1h2.1"
        stroke="currentColor"
        strokeWidth="1.05"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WebFetchIcon() {
  return (
    <svg
      className={styles.chatSummaryToolIcon}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M1.8 7h10.4M7 1.5c1.3 1.5 2 3.3 2 5.5s-.7 4-2 5.5M7 1.5C5.7 3 5 4.8 5 7s.7 4 2 5.5"
        stroke="currentColor"
        strokeWidth="1.05"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      className={styles.chatSummaryToolIcon}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="2"
        y="1.6"
        width="10"
        height="10.8"
        rx="2.2"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M4.5 5.2h5M4.5 7h5M4.5 8.8h5"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TodoIcon() {
  return (
    <svg
      className={styles.chatSummaryToolIcon}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 4.2 4.2 5.4 6.1 3.3M7.5 4.5h3.6M3 9.1l1.2 1.2 1.9-2.1M7.5 9.4h3.6"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AskUserIcon() {
  return (
    <svg
      className={styles.chatSummaryToolIcon}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3.4 3.2h7.2c.7 0 1.25.55 1.25 1.25v3.4c0 .7-.55 1.25-1.25 1.25H7.5L4.5 11V9.1H3.4c-.7 0-1.25-.55-1.25-1.25v-3.4c0-.7.55-1.25 1.25-1.25Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg
      className={styles.chatSummaryToolIcon}
      width="14"
      height="14"
      viewBox="0 0 1024 1024"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        d="M770.08 96.32c1.728.64 3.072 1.984 3.712 3.712l38.848 107.584c.64 1.728 1.984 3.104 3.712 3.712l107.584 38.848a6.144 6.144 0 0 1 0 11.584l-107.584 38.848a6.144 6.144 0 0 0-3.712 3.712l-38.848 107.584a6.144 6.144 0 0 1-11.584 0L723.36 304.32a6.144 6.144 0 0 0-3.712-3.712L612.064 261.76a6.144 6.144 0 0 1 0-11.584l107.584-38.848a6.144 6.144 0 0 0 3.712-3.712l38.848-107.584c1.184-3.2 4.704-4.8 7.872-3.68zM576 160H384q-119.296 0-203.648 84.352Q96 328.704 96 448v192q0 119.296 84.352 203.648Q264.704 928 384 928h256q119.296 0 203.648-84.352Q928 759.296 928 640V512h-64v128q0 92.8-65.6 158.4Q732.8 864 640 864H384q-92.8 0-158.4-65.6Q160 732.8 160 640V448q0-92.8 65.6-158.4Q291.2 224 384 224h192v-64zm96 248.224L568.224 512 672 615.776l45.248-45.28L658.752 512l58.496-58.496L672 408.224zM320 608V448h64v160h-64z"
        stroke="currentColor"
        strokeWidth="28"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ToolSummaryIcon({ tool }: { tool: ACPToolCall }) {
  const kind = getToolHeaderKind(tool);
  if (kind === 'agent') return <AgentIcon />;
  if (kind === 'ask') return <AskUserIcon />;
  if (kind === 'edit' || kind === 'write') return <PencilIcon />;
  if (kind === 'fetch') return <WebFetchIcon />;
  if (kind === 'read') return <FileIcon />;
  if (kind === 'todo') return <TodoIcon />;
  return <ToolGroupIcon />;
}

export function isWebFetchToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === 'web_fetch' || name === 'webfetch' || name === 'fetch';
}

const getCompactDisplayStatus = getAgentDisplayStatus;

function CompactToolGroup({
  tools,
  workspaceCwd,
  isLocateFlashing = false,
}: {
  tools: ACPToolCall[];
  workspaceCwd?: string;
  isLocateFlashing?: boolean;
}) {
  const { t } = useI18n();
  const activeTool = getActiveTool(tools);
  const displayName = localizeToolDisplayName(activeTool.toolName, t);
  const overallStatus = getCompactDisplayStatus(activeTool);
  const description = getToolDescription(activeTool, workspaceCwd);
  const elapsed =
    isShellToolName(activeTool.toolName) ||
    isWebFetchToolName(activeTool.toolName)
      ? ''
      : formatElapsed(activeTool.startTime, activeTool.endTime);

  return (
    <div
      className={`${styles.compactGroup}${
        isLocateFlashing ? ` ${flashStyles.flash}` : ''
      }`}
    >
      <div className={styles.compactHeader}>
        <StatusIcon status={overallStatus} />
        <span className={styles.lineName}>{displayName}</span>
        {tools.length > 1 && (
          <span className={styles.compactCount}>
            {'× '}
            {tools.length}
          </span>
        )}
        <ToolHeaderExtra
          info={{
            kind: getToolHeaderKind(activeTool),
            tool: activeTool,
            displayName,
            description,
            elapsed,
            workspaceCwd,
          }}
        />
      </div>
      <div className={styles.compactHint}>{t('compact.hint')}</div>
    </div>
  );
}

function areToolLinePropsEqual(
  prev: ToolLineProps,
  next: ToolLineProps,
): boolean {
  if (prev.approval?.id !== next.approval?.id) return false;
  if (prev.workspaceCwd !== next.workspaceCwd) return false;
  if (prev.summaryOnly !== next.summaryOnly) return false;
  if (prev.forceExpanded !== next.forceExpanded) return false;
  if (prev.forceExpandable !== next.forceExpandable) return false;
  if (prev.hideHeader !== next.hideHeader) return false;
  if (prev.hideCollapsedOutput !== next.hideCollapsedOutput) return false;
  const a = prev.tool;
  const b = next.tool;
  return (
    a.callId === b.callId &&
    a.toolName === b.toolName &&
    a.status === b.status &&
    a.startTime === b.startTime &&
    a.endTime === b.endTime &&
    a.subContent === b.subContent &&
    a.rawOutput === b.rawOutput &&
    a.args === b.args &&
    a.content === b.content &&
    a.title === b.title &&
    areSubToolsEqual(a.subTools, b.subTools)
  );
}

function areSubToolsEqual(
  prev: ACPToolCall[] | undefined,
  next: ACPToolCall[] | undefined,
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (
      a.callId !== b.callId ||
      a.toolName !== b.toolName ||
      a.status !== b.status ||
      a.endTime !== b.endTime ||
      a.rawOutput !== b.rawOutput ||
      a.args !== b.args ||
      a.subContent !== b.subContent ||
      a.title !== b.title
    ) {
      return false;
    }
  }
  return true;
}

/** Parse `[text](qwen-session://id)` links in plain-text tool output and
 * replace them with clickable `<a>` elements that dispatch a DOM event.
 * Keeps the rendering pipeline plain-text-compatible for all other tools. */
const SESSION_LINK_RE = /\[([^\]]+)\]\(qwen-session:\/\/([^)]+)\)/g;

function renderWithSessionLinks(
  text: string,
  renderMode: 'interactive' | 'readonly',
): ReactNode {
  if (!text || !text.includes('qwen-session://')) return text;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  SESSION_LINK_RE.lastIndex = 0;
  while ((match = SESSION_LINK_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const sessionId = match[2];
    parts.push(
      renderMode === 'readonly' ? (
        <span key={match.index} style={{ textDecoration: 'underline' }}>
          {match[1]}
        </span>
      ) : (
        <a
          key={match.index}
          href="#"
          role="button"
          style={{ textDecoration: 'underline', cursor: 'pointer' }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            window.dispatchEvent(
              new CustomEvent('qwen:open-session', { detail: sessionId }),
            );
          }}
        >
          {match[1]}
        </a>
      ),
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

export const ToolLine = memo(function ToolLine({
  tool,
  approval,
  workspaceCwd,
  summaryOnly = false,
  forceExpanded = false,
  forceExpandable = false,
  hideHeader = false,
  hideCollapsedOutput = false,
}: ToolLineProps) {
  const { t } = useI18n();
  const transcriptRenderMode = useTranscriptRenderMode();
  const compactMode = useContext(CompactModeContext);
  const subagentDetails = useSubagentDetails();
  const [expanded, setExpanded] = useState(
    () => forceExpanded || (!compactMode && shouldAutoExpand(tool)),
  );
  // Set once the user explicitly toggles this row, so auto-collapse-on-
  // completion never silently overrides their choice.
  const userToggledRef = useRef(false);

  useEffect(
    () => {
      setExpanded(
        forceExpanded || (compactMode ? false : shouldAutoExpand(tool)),
      );
      // A new tool identity (or compact-mode toggle) resets the manual latch.
      userToggledRef.current = false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compactMode, forceExpanded, tool.callId, tool.toolName],
  );
  const isAgent = isSubAgentToolCall(tool);
  const hasApproval = approval && approval.toolCallId === tool.callId;
  const hasSubToolApproval =
    !hasApproval &&
    approval?.toolCallId &&
    isAgent &&
    toolContainsCallId(tool, approval.toolCallId);
  const isRunningAgent = isAgent && tool.status === 'in_progress';
  const now = useSharedNow(isRunningAgent);

  // Collapse a regular tool to its one-line summary once it completes
  // successfully — unless the user explicitly toggled this row, in which case
  // their choice wins. Agents are excluded (they keep whatever expand state the
  // user chose, driven from their own panel) and failures stay open so the
  // error output remains visible.
  useEffect(() => {
    if (
      !forceExpanded &&
      !isAgent &&
      tool.status === 'completed' &&
      !userToggledRef.current
    ) {
      setExpanded(false);
    }
  }, [forceExpanded, isAgent, tool.status]);

  if (isAgent) {
    const info = getAgentDisplayInfo(tool, now);
    const displayName = info.explicitAgentType
      ? `${t('agent.label')} (${info.explicitAgentType})`
      : t('agent.label');
    const isComplete = tool.status === 'completed' || tool.status === 'failed';
    const progressLabel =
      tool.status === 'pending' ? t('subagent.pending') : t('subagent.running');
    const runningMeta = [progressLabel, info.elapsed]
      .filter(Boolean)
      .join(' · ');
    const completeMeta = [
      info.subToolCount > 0
        ? t('subagent.toolsCount', { count: info.subToolCount })
        : '',
      info.elapsed,
      info.tokens,
      info.reason ? truncateText(info.reason, 80) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const showExpanded =
      forceExpanded || expanded || !!hasApproval || !!hasSubToolApproval;
    const panel = (
      <SubAgentPanel tool={tool} hideHeader defaultExpanded inline />
    );
    if (subagentDetails) {
      return (
        <div className={styles.line}>
          <button
            type="button"
            className={`${styles.lineMain} ${styles.lineExpandable} ${styles.lineButton}`}
            onClick={() => subagentDetails.onOpen(tool)}
          >
            <AgentIcon />
            <StatusIcon status={isComplete ? info.status : tool.status} />
            <span className={styles.lineName}>{displayName}</span>
            <ToolHeaderExtra
              info={{
                kind: 'agent',
                tool,
                displayName,
                description: info.description
                  ? truncateText(info.description, 60)
                  : '',
                elapsed: isComplete ? completeMeta : runningMeta,
                workspaceCwd,
              }}
            />
            <span className={styles.lineChevronRight} aria-hidden="true" />
          </button>
        </div>
      );
    }
    return (
      <div className={styles.line}>
        {!hideHeader && (
          <div
            className={`${styles.lineMain} ${styles.lineExpandable}`}
            onClick={() => setExpanded(!expanded)}
          >
            <AgentIcon />
            <StatusIcon status={isComplete ? info.status : tool.status} />
            <span className={styles.lineName}>{displayName}</span>
            <ToolHeaderExtra
              info={{
                kind: 'agent',
                tool,
                displayName,
                description: info.description
                  ? truncateText(info.description, 60)
                  : '',
                elapsed: isComplete ? completeMeta : runningMeta,
                workspaceCwd,
              }}
            />
            <span
              className={
                expanded ? styles.lineChevronDown : styles.lineChevronRight
              }
              aria-hidden="true"
            />
          </div>
        )}
        {showExpanded && (
          <div className={styles.lineDetail}>
            {hideHeader ? (
              <div className={styles.expandedAgentCard}>{panel}</div>
            ) : (
              panel
            )}
          </div>
        )}
      </div>
    );
  }

  const fullDescription = getToolDescription(tool, workspaceCwd);
  const result = getToolResultSummary(tool);
  const summaryShell = summaryOnly && isShellToolName(tool.toolName);
  const description = summaryShell
    ? getToolSummaryDescription(tool, workspaceCwd)
    : fullDescription;
  const displayName = localizeToolDisplayName(tool.toolName, t);
  const elapsed =
    isShellToolName(tool.toolName) || isWebFetchToolName(tool.toolName)
      ? ''
      : formatElapsed(tool.startTime, tool.endTime);

  const name = tool.toolName.toLowerCase();
  const isTodo = isTodoWriteToolName(name);
  const todoItems = isTodo ? extractTodosFromToolCall(tool) : undefined;
  const hasTodoList = !!todoItems && todoItems.length > 0;
  const todoCompleted = todoItems
    ? todoItems.filter((td) => td.status === 'completed').length
    : 0;
  const isShell = isShellToolName(name);
  const isSearch =
    name === 'grep' ||
    name === 'grep_search' ||
    name === 'search' ||
    name === 'glob';
  const isRead = name === 'read' || name === 'read_file' || name === 'readfile';
  // A row expands when it has a todo list to reveal, detail output
  // (bash/diff/read content), or a description long enough to be ellipsised.
  // When a long description is expanded we move it out of the header into a
  // wrapped block below, so the header drops its single-line copy.
  const descExpandable = !isTodo && isDescriptionExpandable(description);
  const expandable =
    !forceExpanded &&
    (forceExpandable ||
      (isTodo ? hasTodoList : hasExpandableContent(tool) || descExpandable));
  // Whether the expanded row renders a kind-specific detail view. When it does
  // not (e.g. grep/glob/web_fetch with a long description), keep the result
  // summary visible instead of replacing it with an empty detail area.
  const detailView = hasDetailView(tool);
  const showDescriptionInDetail = expanded && descExpandable;
  const useMarkdownDetail = isRead;
  const hideDescriptionInHeader =
    showDescriptionInDetail && !isShell && !isSearch && !isRead;
  const expandedCardDetail = fullDescription;
  const showExpandedSummaryPanel =
    !isTodo && expanded && !detailView && (showDescriptionInDetail || result);

  return (
    <div className={styles.line}>
      {!hideHeader && (
        <div
          className={`${styles.lineMain} ${expandable ? styles.lineExpandable : ''}`}
          title={
            expandable
              ? expanded
                ? t('tool.collapseHint')
                : t('tool.expand')
              : undefined
          }
          aria-expanded={expandable ? expanded : undefined}
          role={expandable ? 'button' : undefined}
          tabIndex={expandable ? 0 : undefined}
          onClick={
            expandable
              ? () => {
                  userToggledRef.current = true;
                  setExpanded((value) => !value);
                }
              : undefined
          }
          onKeyDown={
            expandable
              ? (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  userToggledRef.current = true;
                  setExpanded((value) => !value);
                }
              : undefined
          }
        >
          <StatusIcon status={tool.status} />
          <span className={styles.lineName}>{displayName}</span>
          {isTodo && hasTodoList && (
            <span className={styles.todoProgress}>
              {todoCompleted}/{todoItems!.length}
            </span>
          )}
          <ToolHeaderExtra
            info={{
              kind: getToolHeaderKind(tool),
              tool,
              displayName,
              // A todo row carries its checklist in the body below; a redundant
              // "Update Todos" description and the instant write duration would
              // only clutter the header next to the progress count.
              description: isTodo || hideDescriptionInHeader ? '' : description,
              elapsed: isTodo ? '' : elapsed,
              workspaceCwd,
            }}
          />
          {expandable && (
            <span
              className={
                expanded ? styles.lineChevronDown : styles.lineChevronRight
              }
              aria-hidden="true"
            />
          )}
        </div>
      )}
      {(!summaryOnly || expanded) && isTodo && hasTodoList && (
        <TodoToolBody
          tool={tool}
          todos={todoItems!}
          expanded={expanded}
          title={displayName}
        />
      )}
      {/* Todo tool whose payload couldn't be parsed (e.g. malformed args):
          fall back to the raw result summary so the row isn't blank. */}
      {(!summaryOnly || expanded) && isTodo && !hasTodoList && result && (
        <div className={styles.lineOutput}>
          {renderWithSessionLinks(result, transcriptRenderMode)}
        </div>
      )}
      {showExpandedSummaryPanel && (
        <ToolExpandedCard title={displayName} detail={expandedCardDetail}>
          {result && (
            <div
              className={`${styles.lineOutput} ${styles.expandedLineOutput}`}
            >
              {renderWithSessionLinks(result, transcriptRenderMode)}
            </div>
          )}
        </ToolExpandedCard>
      )}
      {!isTodo &&
        !hideCollapsedOutput &&
        result &&
        !showExpandedSummaryPanel &&
        (!expanded || !detailView) &&
        (!summaryOnly || expanded) && (
          <div
            className={
              expanded
                ? `${styles.lineOutput} ${styles.expandedLineOutput}`
                : styles.lineOutput
            }
          >
            {renderWithSessionLinks(result, transcriptRenderMode)}
          </div>
        )}
      {!isTodo && expanded && detailView && (
        <div
          className={
            useMarkdownDetail
              ? `${styles.lineDetail} ${styles.markdownLineDetail}`
              : styles.lineDetail
          }
        >
          {isRead ? (
            <ExpandedReadContent tool={tool} />
          ) : (
            <ToolExpandedCard title={displayName} detail={expandedCardDetail}>
              {isShellToolName(name) && <ExpandedBashOutput tool={tool} />}
              {(name === 'write_file' || name === 'writefile') && (
                <ExpandedEditContent tool={tool} />
              )}
              {(name === 'edit' || name === 'write' || name === 'editfile') && (
                <ExpandedEditContent tool={tool} />
              )}
              {isAskUserQuestionToolName(tool.toolName) && (
                <ExpandedAskUserQuestionOutput tool={tool} />
              )}
              {isSkillToolName(name) && <ExpandedSkillOutput tool={tool} />}
            </ToolExpandedCard>
          )}
        </div>
      )}
    </div>
  );
}, areToolLinePropsEqual);

export const ToolGroup = memo(function ToolGroup({
  tools,
  pendingApproval,
  workspaceCwd,
  isLocateFlashing = false,
}: ToolGroupProps) {
  const { t } = useI18n();
  const compactMode = useContext(CompactModeContext);
  const [chatExpanded, setChatExpanded] = useState(false);
  const hasRunningTool = hasActiveTool(tools);
  const hasFailedTool = tools.some((tool) => tool.status === 'failed');
  const activeTool = tools.length > 0 ? getActiveTool(tools) : undefined;
  const singleTool = tools.length === 1 ? tools[0] : undefined;
  const summaryIconTool = tools[0] ?? activeTool;
  const liveStartedAtRef = useRef(Date.now());
  const summaryNow = useSharedNow(hasRunningTool);
  const hasApprovalTool =
    pendingApproval?.toolCallId &&
    tools.some((t) => toolContainsCallId(t, pendingApproval.toolCallId!));
  const showCompact = compactMode && !hasApprovalTool;
  const runningDuration = hasRunningTool
    ? formatLiveElapsed(summaryNow - liveStartedAtRef.current)
    : undefined;

  useEffect(() => {
    if (!hasRunningTool) return;
    liveStartedAtRef.current = Date.now();
  }, [hasRunningTool, activeTool?.callId]);

  if (showCompact) {
    return (
      <CompactToolGroup
        tools={tools}
        workspaceCwd={workspaceCwd}
        isLocateFlashing={isLocateFlashing}
      />
    );
  }

  if (!hasApprovalTool) {
    return (
      <div className={isLocateFlashing ? flashStyles.flash : undefined}>
        <button
          type="button"
          className={styles.chatSummary}
          onClick={() => setChatExpanded((value) => !value)}
          aria-expanded={chatExpanded}
          title={chatExpanded ? t('tool.collapseHint') : t('tool.expand')}
        >
          <span className={styles.chatSummaryIcon} aria-hidden="true">
            {summaryIconTool ? (
              <ToolSummaryIcon tool={summaryIconTool} />
            ) : (
              <ToolGroupIcon />
            )}
          </span>
          {hasFailedTool && <StatusIcon status="failed" />}
          <span
            className={
              hasRunningTool
                ? `${styles.chatSummaryText} ${styles.chatSummaryTextActive}`
                : styles.chatSummaryText
            }
          >
            {singleTool ? (
              <SingleToolSummary
                tool={singleTool}
                runningDuration={hasRunningTool ? runningDuration : undefined}
                workspaceCwd={workspaceCwd}
              />
            ) : (
              formatToolGroupSummary(tools, t, runningDuration)
            )}
          </span>
          <span
            className={
              chatExpanded ? styles.chatChevronDown : styles.chatChevronRight
            }
            aria-hidden="true"
          />
        </button>
        <div
          className={
            chatExpanded
              ? styles.chatSummaryContentClip
              : `${styles.chatSummaryContentClip} ${styles.chatSummaryContentCollapsed}`
          }
        >
          <div className={styles.chatSummaryContentInner}>
            <div className={`${styles.group} ${styles.chatSummaryGroup}`}>
              {tools.map((tool) => (
                <ToolLine
                  key={tool.callId}
                  tool={tool}
                  approval={pendingApproval}
                  workspaceCwd={workspaceCwd}
                  summaryOnly={!singleTool}
                  forceExpanded={!!singleTool}
                  hideHeader={!!singleTool}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${styles.group}${
        isLocateFlashing ? ` ${flashStyles.flash}` : ''
      }`}
    >
      {tools.map((tool) => (
        <ToolLine
          key={tool.callId}
          tool={tool}
          approval={pendingApproval}
          workspaceCwd={workspaceCwd}
        />
      ))}
    </div>
  );
});
