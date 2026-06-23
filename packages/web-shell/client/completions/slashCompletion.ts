import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSection,
} from '@codemirror/autocomplete';
import type { CommandInfo } from '../adapters/types';
import type { WebShellLanguage } from '../i18n';
import {
  compareCommandsByCategory,
  DEFAULT_COMMAND_CATEGORY_ORDER,
  getCategoryRank,
  getCommandDisplayCategory,
  type CommandDisplayCategory,
  type CommandDisplayCategoryOrder,
} from '../utils/commandDisplay';

export interface SkillInfo {
  name: string;
  description: string;
}

export type SlashCommandCompletionKind = 'command' | 'subcommand';

export interface SlashCommandCompletionItem {
  id: string;
  label: string;
  apply: string;
  detail?: string;
  category?: CommandDisplayCategory;
  section?: string;
  type?: 'command-info' | 'skill';
}

export interface SlashCommandCompletionResult {
  kind: SlashCommandCompletionKind;
  from: number;
  to: number;
  query: string;
  items: SlashCommandCompletionItem[];
}

type Translate = (key: string) => string;
const COMMAND_NAME_PATTERN = String.raw`([^\s/]+)`;

interface SubcommandNode {
  name: string;
  description: string;
  children?: SubcommandNode[];
}

const SUBCOMMAND_TREE_ZH: Record<string, SubcommandNode[]> = {
  agents: [
    { name: 'manage', description: '管理现有 subagents' },
    { name: 'create', description: '创建新的 subagent' },
  ],
  theme: [
    { name: 'light', description: '切换到浅色主题' },
    { name: 'dark', description: '切换到深色主题' },
  ],
  export: [
    { name: 'md', description: '将会话导出为 Markdown 文件' },
    { name: 'html', description: '将会话导出为 HTML 文件' },
    { name: 'json', description: '将会话导出为 JSON 文件' },
    { name: 'jsonl', description: '将会话导出为 JSONL 文件（每行一条消息）' },
  ],
  language: [
    {
      name: 'ui',
      description: '设置 UI 语言',
      children: [
        { name: 'en', description: 'English' },
        { name: 'zh-CN', description: '中文' },
      ],
    },
    { name: 'output', description: '设置 LLM 输出语言' },
  ],
  extensions: [
    { name: 'manage', description: '管理扩展' },
    { name: 'install', description: '安装扩展' },
  ],
};

const SUBCOMMAND_TREE_EN: Record<string, SubcommandNode[]> = {
  agents: [
    { name: 'manage', description: 'Manage existing subagents' },
    { name: 'create', description: 'Create a new subagent' },
  ],
  theme: [
    { name: 'light', description: 'Switch to light theme' },
    { name: 'dark', description: 'Switch to dark theme' },
  ],
  export: [
    { name: 'md', description: 'Export as Markdown' },
    { name: 'html', description: 'Export as HTML' },
    { name: 'json', description: 'Export as JSON' },
    { name: 'jsonl', description: 'Export as JSONL' },
  ],
  language: [
    {
      name: 'ui',
      description: 'Set UI language',
      children: [
        { name: 'en', description: 'English' },
        { name: 'zh-CN', description: '中文' },
      ],
    },
    { name: 'output', description: 'Set LLM output language' },
  ],
  extensions: [
    { name: 'manage', description: 'Manage installed extensions' },
    { name: 'install', description: 'Install an extension from a source' },
  ],
};

const IMPLICIT_SUBCOMMAND_TREE_ZH: Record<string, SubcommandNode[]> = {
  context: [{ name: 'detail', description: '显示详细上下文信息' }],
  copy: [
    { name: 'code', description: '复制代码块' },
    { name: 'latex', description: '复制 LaTeX 公式' },
    { name: 'inline-latex', description: '复制行内 LaTeX 公式' },
  ],
  tools: [{ name: 'desc', description: '显示工具详细描述' }],
  stats: [
    { name: 'model', description: '显示各模型使用统计' },
    { name: 'tools', description: '显示工具使用统计' },
  ],
  mcp: [
    { name: 'desc', description: '显示 MCP server 和工具描述' },
    { name: 'nodesc', description: '隐藏 MCP server 和工具描述' },
    { name: 'schema', description: '显示工具参数 schema' },
  ],
  memory: [
    { name: 'show', description: '查看 memory 文件' },
    { name: 'add', description: '新增 memory' },
    { name: 'refresh', description: '刷新 memory 文件列表' },
  ],
};

const IMPLICIT_SUBCOMMAND_TREE_EN: Record<string, SubcommandNode[]> = {
  context: [{ name: 'detail', description: 'Show detailed context info' }],
  copy: [
    { name: 'code', description: 'Copy code blocks' },
    { name: 'latex', description: 'Copy LaTeX formula' },
    { name: 'inline-latex', description: 'Copy inline LaTeX formula' },
  ],
  tools: [{ name: 'desc', description: 'Show tool descriptions' }],
  stats: [
    { name: 'model', description: 'Show per-model usage statistics' },
    { name: 'tools', description: 'Show tool usage statistics' },
  ],
  mcp: [
    { name: 'desc', description: 'Show MCP server and tool descriptions' },
    { name: 'nodesc', description: 'Hide MCP server and tool descriptions' },
    { name: 'schema', description: 'Show tool parameter schemas' },
  ],
  memory: [
    { name: 'show', description: 'Show memory files' },
    { name: 'add', description: 'Add memory' },
    { name: 'refresh', description: 'Refresh memory files' },
  ],
};

function resolveSubcommands(
  cmdName: string,
  parts: string[],
  dynamicSkills: SkillInfo[] | undefined,
  language: WebShellLanguage,
  commandSubcommands?: string[],
): SubcommandNode[] | null {
  if (cmdName === 'skills' && parts.length === 0) {
    if (!dynamicSkills || dynamicSkills.length === 0) return null;
    return dynamicSkills.map((s) => ({
      name: s.name,
      description: s.description,
    }));
  }

  const tree = language === 'zh-CN' ? SUBCOMMAND_TREE_ZH : SUBCOMMAND_TREE_EN;
  let nodes = tree[cmdName];

  if (!nodes) {
    const implicitTree =
      language === 'zh-CN'
        ? IMPLICIT_SUBCOMMAND_TREE_ZH
        : IMPLICIT_SUBCOMMAND_TREE_EN;
    nodes = implicitTree[cmdName];
  }

  if (!nodes && parts.length === 0 && commandSubcommands?.length) {
    nodes = commandSubcommands.map((name) => ({
      name,
      description: '',
    }));
  }

  if (!nodes) return null;

  for (const part of parts) {
    const match = nodes.find((n) => n.name === part);
    if (!match?.children) return null;
    nodes = match.children;
  }
  return nodes;
}

function comparePrefixFirst(a: string, b: string, query: string): number {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  const aStarts = aLower.startsWith(query);
  const bStarts = bLower.startsWith(query);
  if (aStarts !== bStarts) return aStarts ? -1 : 1;
  return a.localeCompare(b);
}

function compareSlashCommands(
  a: CommandInfo,
  b: CommandInfo,
  query: string,
  categoryOrder: CommandDisplayCategoryOrder,
): number {
  const order = compareCommandsByCategory(a, b, categoryOrder);
  if (order !== 0) return order;
  return query ? comparePrefixFirst(a.name, b.name, query) : 0;
}

const COMMAND_SECTION_KEYS: Record<CommandDisplayCategory, string> = {
  custom: 'slash.category.custom',
  skill: 'slash.category.skill',
  system: 'slash.category.system',
};

function renderCommandSectionHeader(section: CompletionSection): HTMLElement {
  const header = document.createElement('completion-section');
  header.className = 'cm-command-section-header';
  header.setAttribute('aria-label', section.name);
  return header;
}

function getCommandSection(
  command: CommandInfo,
  translate: Translate,
  categoryOrder: CommandDisplayCategoryOrder,
): CompletionSection {
  const category = getCommandDisplayCategory(command);
  return {
    name: translate(COMMAND_SECTION_KEYS[category]),
    rank: getCategoryRank(category, categoryOrder),
    header: renderCommandSectionHeader,
  };
}

export function getMissingSlashPrefixCompletion(
  text: string,
  commands: CommandInfo[],
): string | null {
  if (!text || text.includes(' ') || /^[/@!?]/.test(text)) return null;

  const lp = text.toLowerCase();
  const match = commands.find((c) => c.name.toLowerCase().startsWith(lp));
  if (!match) return null;

  return `/${match.name} `;
}

export function getImplicitTabCompletion(
  text: string,
  commands: CommandInfo[],
  language: WebShellLanguage,
): string | null {
  const match = text.match(new RegExp(`^/${COMMAND_NAME_PATTERN}\\s+$`));
  if (!match) return null;

  const cmdName = match[1];
  const cmd = commands.find((c) => c.name === cmdName);
  const tree = language === 'zh-CN' ? SUBCOMMAND_TREE_ZH : SUBCOMMAND_TREE_EN;
  if (cmd?.subcommands?.length || tree[cmdName] || cmdName === 'skills') {
    return null;
  }

  const implicitTree =
    language === 'zh-CN'
      ? IMPLICIT_SUBCOMMAND_TREE_ZH
      : IMPLICIT_SUBCOMMAND_TREE_EN;
  const nodes = implicitTree[cmdName];
  if (!nodes || nodes.length === 0) return null;

  return `/${cmdName} ${nodes[0].name} `;
}

export function getSlashCommandArgumentHint(
  text: string,
  commands: CommandInfo[],
  language: WebShellLanguage,
): string | null {
  const match = text.match(new RegExp(`^/${COMMAND_NAME_PATTERN}(\\s*)$`));
  if (!match) return null;

  const cmdName = match[1];
  const cmd = commands.find((c) => c.name === cmdName);
  if (!cmd) return null;

  const argumentHint = cmd.argumentHint?.trim();
  if (argumentHint) return argumentHint;

  const tree = language === 'zh-CN' ? SUBCOMMAND_TREE_ZH : SUBCOMMAND_TREE_EN;
  if (cmd.subcommands?.length || tree[cmdName] || cmdName === 'skills') {
    return null;
  }

  const implicitTree =
    language === 'zh-CN'
      ? IMPLICIT_SUBCOMMAND_TREE_ZH
      : IMPLICIT_SUBCOMMAND_TREE_EN;
  const nodes = implicitTree[cmdName];
  if (!nodes || nodes.length === 0) return null;

  return `[${nodes.map((node) => node.name).join('|')}]`;
}

function getLineBounds(text: string, cursor: number) {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const lineStart = text.lastIndexOf('\n', Math.max(0, safeCursor - 1)) + 1;
  const nextNewline = text.indexOf('\n', safeCursor);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  return {
    lineStart,
    lineEnd,
    lineText: text.slice(lineStart, lineEnd),
    textBefore: text.slice(lineStart, safeCursor),
    cursor: safeCursor,
  };
}

export function getSlashCommandCompletionResult(
  text: string,
  cursor: number,
  commands: CommandInfo[],
  skills: SkillInfo[] = [],
  language: WebShellLanguage = 'en',
  translate: Translate = (key) => key,
  categoryOrder: CommandDisplayCategoryOrder = DEFAULT_COMMAND_CATEGORY_ORDER,
): SlashCommandCompletionResult | null {
  const {
    lineStart,
    lineEnd,
    lineText,
    textBefore,
    cursor: safeCursor,
  } = getLineBounds(text, cursor);

  const subMatch = textBefore.match(
    new RegExp(`^/${COMMAND_NAME_PATTERN}\\s+(.*)$`),
  );
  if (subMatch) {
    const [, cmdName, rest] = subMatch;
    const cmd = commands.find((c) => c.name === cmdName);
    const tree = language === 'zh-CN' ? SUBCOMMAND_TREE_ZH : SUBCOMMAND_TREE_EN;
    const implicitTree =
      language === 'zh-CN'
        ? IMPLICIT_SUBCOMMAND_TREE_ZH
        : IMPLICIT_SUBCOMMAND_TREE_EN;
    const hasTree = !!tree[cmdName] || cmdName === 'skills';
    const hasImplicitTree = !!implicitTree[cmdName];
    if (!cmd?.subcommands?.length && !hasTree && !hasImplicitTree) {
      return null;
    }

    const tokens = rest.split(/\s+/);
    const currentTyping = tokens.pop() || '';
    const completedParts = tokens;

    if (
      !cmd?.subcommands?.length &&
      !hasTree &&
      hasImplicitTree &&
      !currentTyping
    ) {
      return null;
    }

    const nodes = resolveSubcommands(
      cmdName,
      completedParts,
      skills,
      language,
      cmd?.subcommands,
    );
    if (!nodes) return null;

    const lp = currentTyping.toLowerCase();
    const prefix = `/${cmdName} ${
      completedParts.length > 0 ? completedParts.join(' ') + ' ' : ''
    }`;
    const filteredNodes = nodes
      .filter((n) => !currentTyping || n.name.toLowerCase().includes(lp))
      .sort((a, b) =>
        currentTyping ? comparePrefixFirst(a.name, b.name, lp) : 0,
      );
    const isSkillList = cmdName === 'skills' && completedParts.length === 0;
    const items = filteredNodes.map((node): SlashCommandCompletionItem => {
      const command = `${prefix}${node.name}`;
      return {
        id: command,
        label: node.name,
        detail: node.description || undefined,
        apply: `${command} `,
        ...(isSkillList ? { type: 'skill' as const } : {}),
      };
    });

    if (items.length === 0) return null;
    return {
      kind: 'subcommand',
      from: lineStart,
      to: safeCursor,
      query: currentTyping,
      items,
    };
  }

  const match = lineText.match(/^\/([^\s/]*)$/);
  if (!match) return null;

  const prefix = match[1];
  const lp = prefix.toLowerCase();
  const filteredCommands = commands
    .filter((command) => {
      if (!prefix) return true;
      return command.name.toLowerCase().includes(lp);
    })
    .sort((a, b) => compareSlashCommands(a, b, lp, categoryOrder));

  const items = filteredCommands.map((command): SlashCommandCompletionItem => {
    const apply = `/${command.name} `;
    const category = getCommandDisplayCategory(command);
    const showCommandInfo = category === 'custom' || category === 'skill';
    return {
      id: command.name,
      label: `/${command.name}`,
      detail: command.description || undefined,
      apply,
      category,
      section: translate(COMMAND_SECTION_KEYS[category]),
      ...(showCommandInfo && command.description
        ? { type: 'command-info' as const }
        : {}),
    };
  });

  if (items.length === 0) return null;
  return {
    kind: 'command',
    from: lineStart,
    to: lineEnd,
    query: prefix,
    items,
  };
}

export function slashCompletionSource(
  getCommands: () => CommandInfo[],
  getSkills: () => SkillInfo[] = () => [],
  getLanguage: () => WebShellLanguage = () => 'en',
  translate: Translate = (key) => key,
  getCategoryOrder: () => CommandDisplayCategoryOrder | undefined = () =>
    DEFAULT_COMMAND_CATEGORY_ORDER,
) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const textBefore = line.text.slice(0, context.pos - line.from);

    // Sub-command completion: "/command arg1 arg2..."
    const subMatch = textBefore.match(
      new RegExp(`^/${COMMAND_NAME_PATTERN}\\s+(.*)$`),
    );
    if (subMatch) {
      const [, cmdName, rest] = subMatch;
      const commands = getCommands();
      const cmd = commands.find((c) => c.name === cmdName);
      const language = getLanguage();
      const tree =
        language === 'zh-CN' ? SUBCOMMAND_TREE_ZH : SUBCOMMAND_TREE_EN;
      const implicitTree =
        language === 'zh-CN'
          ? IMPLICIT_SUBCOMMAND_TREE_ZH
          : IMPLICIT_SUBCOMMAND_TREE_EN;
      const hasTree = !!tree[cmdName] || cmdName === 'skills';
      const hasImplicitTree = !!implicitTree[cmdName];
      if (!cmd?.subcommands?.length && !hasTree && !hasImplicitTree)
        return null;

      // Split rest into completed parts and current typing
      const tokens = rest.split(/\s+/);
      const currentTyping = tokens.pop() || '';
      const completedParts = tokens;

      // Implicit sub-commands: only show when user starts typing (not on space alone)
      if (
        !cmd?.subcommands?.length &&
        !hasTree &&
        hasImplicitTree &&
        !currentTyping
      ) {
        return null;
      }

      const nodes = resolveSubcommands(
        cmdName,
        completedParts,
        getSkills(),
        language,
        cmd?.subcommands,
      );
      if (!nodes) return null;

      const lp = currentTyping.toLowerCase();
      const prefix = `/${cmdName} ${completedParts.length > 0 ? completedParts.join(' ') + ' ' : ''}`;
      const filteredNodes = nodes
        .filter((n) => !currentTyping || n.name.toLowerCase().includes(lp))
        .sort((a, b) =>
          currentTyping ? comparePrefixFirst(a.name, b.name, lp) : 0,
        );
      const isSkillList = cmdName === 'skills' && completedParts.length === 0;
      const maxNameLength = isSkillList
        ? Math.max(...filteredNodes.map((n) => n.name.length), 0)
        : 0;
      const options = filteredNodes.map((n): Completion => {
        const command = `${prefix}${n.name}`;
        const padLength = Math.max(maxNameLength - n.name.length, 0);
        return {
          label: n.name,
          ...(isSkillList
            ? {
                displayLabel: `${n.name}${'\u00a0'.repeat(padLength)}`,
                type: 'skill',
              }
            : {}),
          detail: n.description || undefined,
          apply: `${command} `,
        };
      });

      if (options.length === 0) return null;

      return {
        from: line.from,
        options,
        filter: false,
      };
    }

    // Top-level command completion: "/" or "/ex".
    // Use the whole line so moving the cursor before or inside the command
    // still offers the same completions and replaces the full command token.
    const match = line.text.match(/^\/([^\s/]*)$/);
    if (!match) return null;

    const prefix = match[1];
    const commands = getCommands();
    const categoryOrder = getCategoryOrder() ?? DEFAULT_COMMAND_CATEGORY_ORDER;
    const lp = prefix.toLowerCase();
    const filteredCommands = commands
      .filter((c) => {
        if (!prefix) return true;
        return c.name.toLowerCase().includes(lp);
      })
      .sort((a, b) => compareSlashCommands(a, b, lp, categoryOrder));
    const options = filteredCommands.map((c): Completion => {
      const command = `/${c.name}`;
      const category = getCommandDisplayCategory(c);
      const showCommandInfo = category === 'custom' || category === 'skill';
      return {
        label: command,
        detail: c.description || undefined,
        ...(showCommandInfo && c.description ? { type: 'command-info' } : {}),
        apply: `${command} `,
        section: getCommandSection(c, translate, categoryOrder),
      };
    });

    if (options.length === 0) return null;

    return {
      from: line.from,
      to: line.to,
      options,
      filter: false,
    };
  };
}
