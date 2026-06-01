import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import type { CommandInfo } from '../adapters/types';
import type { WebShellLanguage } from '../i18n';

export interface SkillInfo {
  name: string;
  description: string;
}

interface SubcommandNode {
  name: string;
  description: string;
  children?: SubcommandNode[];
}

const SUBCOMMAND_TREE_ZH: Record<string, SubcommandNode[]> = {
  agents: [
    { name: 'manage', description: '管理现有 subagents' },
    {
      name: 'create',
      description: '创建新的 subagent',
      children: [
        { name: 'user', description: '创建 User subagent' },
        { name: 'project', description: '创建 Project subagent' },
      ],
    },
  ],
  theme: [
    { name: 'light', description: '切换到浅色主题' },
    { name: 'dark', description: '切换到深色主题' },
  ],
  memory: [
    {
      name: 'add',
      description: '新增 memory',
      children: [
        { name: 'user', description: '写入 User memory' },
        { name: 'project', description: '写入 Project memory' },
      ],
    },
    { name: 'show', description: '查看 memory 文件' },
    { name: 'refresh', description: '刷新 memory 文件列表' },
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
};

const SUBCOMMAND_TREE_EN: Record<string, SubcommandNode[]> = {
  agents: [
    { name: 'manage', description: 'Manage existing subagents' },
    {
      name: 'create',
      description: 'Create a new subagent',
      children: [
        { name: 'user', description: 'Create a user subagent' },
        { name: 'project', description: 'Create a project subagent' },
      ],
    },
  ],
  theme: [
    { name: 'light', description: 'Switch to light theme' },
    { name: 'dark', description: 'Switch to dark theme' },
  ],
  memory: [
    {
      name: 'add',
      description: 'Add memory',
      children: [
        { name: 'user', description: 'Write user memory' },
        { name: 'project', description: 'Write project memory' },
      ],
    },
    { name: 'show', description: 'Show memory files' },
    { name: 'refresh', description: 'Refresh memory files' },
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
};

function resolveSubcommands(
  cmdName: string,
  parts: string[],
  dynamicSkills: SkillInfo[] | undefined,
  language: WebShellLanguage,
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

export function slashCompletionSource(
  getCommands: () => CommandInfo[],
  getSkills: () => SkillInfo[] = () => [],
  getLanguage: () => WebShellLanguage = () => 'en',
) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const textBefore = line.text.slice(0, context.pos - line.from);

    // Sub-command completion: "/command arg1 arg2..."
    const subMatch = textBefore.match(/^\/(\w[\w-]*)\s+(.*)$/);
    if (subMatch) {
      const [, cmdName, rest] = subMatch;
      const commands = getCommands();
      const cmd = commands.find((c) => c.name === cmdName);
      const language = getLanguage();
      const tree =
        language === 'zh-CN' ? SUBCOMMAND_TREE_ZH : SUBCOMMAND_TREE_EN;
      const hasTree = !!tree[cmdName] || cmdName === 'skills';
      if (!cmd?.subcommands?.length && !hasTree) return null;

      // Split rest into completed parts and current typing
      const tokens = rest.split(/\s+/);
      const currentTyping = tokens.pop() || '';
      const completedParts = tokens;

      const nodes = resolveSubcommands(
        cmdName,
        completedParts,
        getSkills(),
        language,
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

    // Top-level command completion: "/" or "/ex"
    const match = textBefore.match(/^\/(\w*)$/);
    if (!match) return null;

    const prefix = match[1];
    const commands = getCommands();

    const lp = prefix.toLowerCase();
    const options = commands
      .filter((c) => {
        if (!prefix) return true;
        return c.name.toLowerCase().includes(lp);
      })
      .sort((a, b) => (prefix ? comparePrefixFirst(a.name, b.name, lp) : 0))
      .map((c): Completion => {
        const command = `/${c.name}`;
        return {
          label: command,
          detail: c.description || undefined,
          apply: `${command} `,
        };
      });

    if (options.length === 0) return null;

    return {
      from: line.from,
      options,
      filter: false,
    };
  };
}
