import type { ACPToolCall } from '../../adapters/types';

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  edit: 'Edit',
  write_file: 'WriteFile',
  read_file: 'ReadFile',
  grep_search: 'Grep',
  glob: 'Glob',
  run_shell_command: 'Shell',
  todo_write: 'TodoWrite',
  save_memory: 'SaveMemory',
  agent: 'Agent',
  skill: 'Skill',
  exit_plan_mode: 'ExitPlanMode',
  web_fetch: 'WebFetch',
  list_directory: 'ListFiles',
  lsp: 'Lsp',
  ask_user_question: 'AskUserQuestion',
  cron_create: 'CronCreate',
  cron_list: 'CronList',
  cron_delete: 'CronDelete',
  task_stop: 'TaskStop',
  send_message: 'SendMessage',
  structured_output: 'StructuredOutput',
  monitor: 'Monitor',
  notebook_edit: 'NotebookEdit',
  tool_search: 'ToolSearch',
  enter_worktree: 'EnterWorktree',
  exit_worktree: 'ExitWorktree',
  web_search: 'WebSearch',
  bash: 'Shell',
  shell: 'Shell Command',
  read: 'ReadFile',
  write: 'WriteFile',
  search: 'Grep',
};

export function formatToolDisplayName(toolName: string): string {
  return TOOL_DISPLAY_NAMES[toolName] ?? toolName;
}

export function isAskUserQuestionToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized === 'ask_user_question' || normalized === 'askuserquestion';
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

// The tool-header description is shown single-line (CSS-ellipsised) when the
// row is collapsed and fully wrapped when it is expanded, so we keep the whole
// string rather than hard-capping it at a line's worth of characters. A
// generous ceiling still guards against a pathological multi-megabyte command
// bloating the DOM.
const MAX_DESCRIPTION_LENGTH = 2000;

export function getToolDescription(
  tool: ACPToolCall,
  workspaceCwd?: string,
): string {
  const fromTitle = getDescriptionFromTitle(tool, workspaceCwd);
  if (fromTitle) return truncateText(fromTitle, MAX_DESCRIPTION_LENGTH);
  const fromArgs = getDescriptionFromArgs(tool, workspaceCwd);
  if (fromArgs) return truncateText(fromArgs, MAX_DESCRIPTION_LENGTH);
  return '';
}

export function extractText(tool: ACPToolCall): string | null {
  if (!tool.content) {
    return extractRawOutputText(tool.rawOutput);
  }
  for (const b of tool.content) {
    if (b.type === 'content' && b.content?.text) return b.content.text;
  }
  return extractRawOutputText(tool.rawOutput);
}

export function getToolResultSummary(tool: ACPToolCall): string {
  if (tool.status !== 'completed' && tool.status !== 'failed') return '';

  const text = extractText(tool);
  if (!text) return '';

  const name = tool.toolName.toLowerCase();
  const lines = text.split('\n');
  const lineCount = lines.length;

  if (name === 'read' || name === 'read_file' || name === 'readfile') {
    return `${lineCount} line(s)`;
  }

  if (name === 'glob') {
    const itemCount = lines.filter((l) => l.trim()).length;
    return `Found ${itemCount} matching file(s)`;
  }

  if (name === 'list_directory' || name === 'listfiles') {
    const itemCount = lines.filter((l) => l.trim()).length;
    return `${itemCount} item(s)`;
  }

  if (isShellToolName(name)) {
    if (lineCount > 3) return `${lineCount} lines of output`;
    const firstLine = lines[0] || '';
    return truncateText(firstLine, 80);
  }

  if (name === 'grep' || name === 'search') {
    const matchCount = lines.filter((l) => l.trim()).length;
    return `${matchCount} result(s)`;
  }

  if (
    name === 'edit' ||
    name === 'write' ||
    name === 'write_file' ||
    name === 'editfile'
  ) {
    return '';
  }

  if (name === 'webfetch' || name === 'web_fetch' || name === 'fetch') {
    const firstLine = lines[0] || '';
    return truncateText(firstLine, 80);
  }

  if (name === 'websearch' || name === 'web_search') {
    const matchCount = lines.filter((l) => l.trim()).length;
    if (matchCount > 1) return `${matchCount} result(s)`;
    return lines[0] || '';
  }

  if (isAskUserQuestionToolName(name)) return '';

  const firstLine = lines[0] || '';
  return truncateText(firstLine, 80);
}

function getDescriptionFromTitle(
  tool: ACPToolCall,
  workspaceCwd?: string,
): string | null {
  if (!tool.title) return null;

  const displayName = formatToolDisplayName(tool.toolName);
  const title = tool.title.trim();
  if (title === tool.toolName || title === displayName) return null;

  const prefixes = [displayName, tool.toolName];
  for (const prefix of prefixes) {
    if (title.startsWith(prefix)) {
      const suffix = title.slice(prefix.length);
      if (/^(:\s*|\s+)/.test(suffix)) {
        return formatDescriptionPaths(
          suffix.replace(/^:\s*|\s+/, ''),
          workspaceCwd,
        );
      }
    }
  }

  return formatDescriptionPaths(title, workspaceCwd);
}

function getDescriptionFromArgs(
  tool: ACPToolCall,
  workspaceCwd?: string,
): string {
  const args = tool.args || {};
  const name = tool.toolName.toLowerCase();

  if (args.command) {
    let description = String(args.command);
    if (args.directory && name !== 'shell') {
      description += ` [in ${pathForDisplay(String(args.directory), workspaceCwd)}]`;
    }
    if (args.is_background) {
      description += ' [background]';
    } else if (args.timeout) {
      description += ` [timeout: ${String(args.timeout)}ms]`;
    }
    if (args.description) {
      description += ` (${String(args.description).replace(/\n/g, ' ')})`;
    }
    return truncateText(description, MAX_DESCRIPTION_LENGTH);
  }
  if (name === 'grep_search' || name === 'grep' || name === 'search') {
    const pattern = args.pattern ?? args.query;
    if (pattern) {
      let description = `'${String(pattern)}'`;
      if (args.path) {
        description += ` in path '${String(args.path)}'`;
      } else if (name === 'grep_search' || name === 'grep') {
        description += ` in path './'`;
      }
      if (args.glob) description += ` (filter: '${String(args.glob)}')`;
      return description;
    }
  }
  if (name === 'glob' && args.pattern) {
    let description = `'${String(args.pattern)}'`;
    if (args.path) {
      description += ` in path '${String(args.path)}'`;
    }
    return description;
  }
  if (args.file_path) {
    if (args.description) return String(args.description);
    return pathForDisplay(String(args.file_path), workspaceCwd);
  }
  if (args.url) {
    const url = String(args.url);
    const prompt =
      typeof args.prompt === 'string' ? (args.prompt as string) : undefined;
    const desc = prompt ? `${url} — "${truncateText(prompt, 40)}"` : url;
    return truncateText(desc, 80);
  }
  if (args.path) return pathForDisplay(String(args.path), workspaceCwd);
  if (args.query) {
    return truncateText(String(args.query), 60);
  }
  if (name === 'list_directory' || name === 'listfiles') {
    const candidate = args.path || args.directory || '';
    return pathForDisplay(String(candidate), workspaceCwd);
  }
  if (args.description) return String(args.description);
  return '';
}

export function isShellToolName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === 'run_shell_command' ||
    normalized === 'bash' ||
    normalized === 'shell' ||
    normalized === 'execute_command'
  );
}

export function toolContainsCallId(
  tool: ACPToolCall,
  toolCallId: string,
): boolean {
  if (tool.callId === toolCallId) return true;
  return (
    tool.subTools?.some((sub) => toolContainsCallId(sub, toolCallId)) ?? false
  );
}

function formatDescriptionPaths(
  description: string,
  workspaceCwd?: string,
): string {
  const trimmed = description.trim();
  if (isAbsoluteLikePath(normalizeSeparators(trimmed))) {
    return pathForDisplay(trimmed, workspaceCwd);
  }

  return trimmed.replace(/(?:[A-Za-z]:)?\/[^\s'")]+/g, (match) =>
    pathForDisplay(match, workspaceCwd),
  );
}

function pathForDisplay(filePath: string, workspaceCwd?: string): string {
  const normalizedPath = normalizeSeparators(filePath);
  const normalizedCwd = workspaceCwd
    ? normalizeSeparators(workspaceCwd).replace(/\/+$/, '')
    : '';

  if (
    normalizedCwd &&
    (normalizedPath === normalizedCwd ||
      normalizedPath.startsWith(`${normalizedCwd}/`))
  ) {
    const relativePath = normalizedPath.slice(normalizedCwd.length + 1);
    return relativePath || '.';
  }

  if (isAbsoluteLikePath(normalizedPath)) {
    return basename(normalizedPath);
  }

  return normalizedPath;
}

function normalizeSeparators(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function isAbsoluteLikePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[A-Za-z]:\//.test(filePath);
}

function basename(filePath: string): string {
  const trimmed = filePath.replace(/\/+$/, '');
  return trimmed.split('/').pop() || filePath;
}

// ── Shared agent helpers (used by ParallelAgentsGroup & SubAgentPanel) ──

export function getTaskExecutionRecord(
  rawOutput: unknown,
): Record<string, unknown> | undefined {
  if (!rawOutput || typeof rawOutput !== 'object') return undefined;
  const record = rawOutput as Record<string, unknown>;
  return record['type'] === 'task_execution' ? record : undefined;
}

export function getAgentCancellationReason(agent: ACPToolCall): string {
  if (!agent.rawOutput || typeof agent.rawOutput !== 'object') return '';
  const raw = agent.rawOutput as Record<string, unknown>;
  const terminateReason =
    typeof raw.terminateReason === 'string' ? raw.terminateReason : '';
  return (
    (typeof raw.reason === 'string' && raw.reason) ||
    (terminateReason && terminateReason !== 'GOAL' && terminateReason) ||
    (typeof raw.error === 'string' && raw.error) ||
    ''
  );
}

export function getAgentDisplayStatus(
  agent: ACPToolCall,
): ACPToolCall['status'] {
  if (agent.status === 'failed') return 'failed';
  if (!agent.rawOutput || typeof agent.rawOutput !== 'object') {
    return agent.status;
  }
  const raw = agent.rawOutput as Record<string, unknown>;
  const status = typeof raw.status === 'string' ? raw.status.toLowerCase() : '';
  const reason = getAgentCancellationReason(agent);
  if (
    status === 'cancelled' ||
    status === 'canceled' ||
    reason.toLowerCase().includes('cancel')
  ) {
    return 'failed';
  }
  return agent.status;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M tokens`;
  if (tokens >= 1000)
    return (tokens / 1000).toFixed(1).replace(/\.0$/, '') + 'k tokens';
  return `${tokens} tokens`;
}

const DEFAULT_SUBAGENT_TYPE = 'general-purpose';

export function getAgentType(agent: ACPToolCall): string {
  const taskExec = getTaskExecutionRecord(agent.rawOutput);
  if (taskExec) {
    const name = taskExec['subagentName'];
    if (typeof name === 'string' && name) return name;
  }
  const subagentType = agent.args?.subagent_type;
  if (typeof subagentType === 'string' && subagentType) return subagentType;
  return agent.toolName === 'task' ? 'task' : DEFAULT_SUBAGENT_TYPE;
}

export function getAgentDescription(agent: ACPToolCall): string {
  if (agent.title) {
    const colonIdx = agent.title.indexOf(': ');
    if (colonIdx > 0) return agent.title.slice(colonIdx + 2);
  }
  const desc = agent.args?.description;
  if (typeof desc === 'string' && desc.trim()) return desc.trim();
  const taskExec = getTaskExecutionRecord(agent.rawOutput);
  const taskDesc = taskExec?.['taskDescription'];
  if (typeof taskDesc === 'string' && taskDesc.trim()) return taskDesc.trim();
  const prompt = agent.args?.prompt;
  if (typeof prompt === 'string' && prompt.trim()) {
    return prompt.trim().split('\n')[0] ?? '';
  }
  return '';
}

export function getAgentCurrentToolHint(agent: ACPToolCall): string {
  if (agent.status !== 'in_progress') return '';
  const subs = agent.subTools;
  if (!subs || subs.length === 0) return '';
  const last = subs[subs.length - 1];
  if (last.status !== 'in_progress' && last.status !== 'pending') return '';
  let hint = last.toolName;
  if (last.title) {
    const colonIdx = last.title.indexOf(': ');
    hint += ' ' + (colonIdx > 0 ? last.title.slice(colonIdx + 2) : last.title);
  } else if (last.args?.command) {
    hint += ' ' + String(last.args.command);
  } else if (last.args?.file_path) {
    hint += ' ' + String(last.args.file_path);
  }
  return truncateText(hint, 50);
}

function extractRawOutputText(rawOutput: unknown): string | null {
  if (!rawOutput) return null;
  if (typeof rawOutput === 'string') return rawOutput;
  if (typeof rawOutput !== 'object') return null;

  const raw = rawOutput as Record<string, unknown>;
  if (typeof raw.output === 'string') return raw.output;
  if (typeof raw.stdout === 'string') return raw.stdout;
  if (typeof raw.content === 'string') return raw.content;
  if (typeof raw.reason === 'string') return raw.reason;
  if (typeof raw.terminateReason === 'string') return raw.terminateReason;
  if (typeof raw.error === 'string') return raw.error;
  if (typeof raw.text === 'string') return raw.text;
  return null;
}
