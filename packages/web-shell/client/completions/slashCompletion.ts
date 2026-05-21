import type {
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import type { CommandInfo } from '../adapters/types';

interface SubcommandNode {
  name: string;
  description: string;
  children?: SubcommandNode[];
}

const SUBCOMMAND_TREE: Record<string, SubcommandNode[]> = {
  export: [
    { name: 'md', description: '将会话导出为 Markdown 文件' },
    { name: 'html', description: '将会话导出为 HTML 文件' },
    { name: 'json', description: '将会话导出为 JSON 文件' },
    { name: 'jsonl', description: '将会话导出为 JSONL 文件（每行一条消息）' },
  ],
  stats: [
    { name: 'model', description: '显示各模型的使用统计' },
    { name: 'tools', description: '显示工具调用统计' },
  ],
  language: [
    {
      name: 'ui',
      description: '设置 UI 语言',
      children: [
        { name: 'en-US', description: 'English' },
        { name: 'zh-TW', description: '繁體中文' },
        { name: 'zh-CN', description: '中文' },
        { name: 'ru-RU', description: 'Русский' },
        { name: 'de-DE', description: 'Deutsch' },
        { name: 'ja-JP', description: '日本語' },
        { name: 'pt-BR', description: 'Português' },
        { name: 'fr-FR', description: 'Français' },
        { name: 'ca-ES', description: 'Català' },
      ],
    },
    { name: 'output', description: '设置 LLM 输出语言' },
    {
      name: 'translate',
      description: '管理动态命令翻译',
      children: [
        { name: 'on', description: '启用动态命令翻译' },
        { name: 'off', description: '禁用动态命令翻译' },
        { name: 'status', description: '查看翻译状态' },
        {
          name: 'cache',
          description: '管理翻译缓存',
          children: [
            { name: 'refresh', description: '重新翻译当前已加载的动态描述' },
            { name: 'clear', description: '清除当前语言的翻译缓存' },
          ],
        },
      ],
    },
  ],
};

function resolveSubcommands(
  cmdName: string,
  parts: string[],
  dynamicSkills: string[] | undefined,
): SubcommandNode[] | null {
  if (cmdName === 'skills' && parts.length === 0) {
    if (!dynamicSkills || dynamicSkills.length === 0) return null;
    return dynamicSkills.map((s) => ({ name: s, description: '' }));
  }

  let nodes = SUBCOMMAND_TREE[cmdName];
  if (!nodes) return null;

  for (const part of parts) {
    const match = nodes.find((n) => n.name === part);
    if (!match?.children) return null;
    nodes = match.children;
  }
  return nodes;
}

export function slashCompletionSource(
  getCommands: () => CommandInfo[],
  getSkills: () => string[] = () => [],
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
      const hasTree = !!SUBCOMMAND_TREE[cmdName] || cmdName === 'skills';
      if (!cmd?.subcommands?.length && !hasTree) return null;

      // Split rest into completed parts and current typing
      const tokens = rest.split(/\s+/);
      const currentTyping = tokens.pop() || '';
      const completedParts = tokens;

      const nodes = resolveSubcommands(cmdName, completedParts, getSkills());
      if (!nodes) return null;

      const lp = currentTyping.toLowerCase();
      const prefix = `/${cmdName} ${completedParts.length > 0 ? completedParts.join(' ') + ' ' : ''}`;
      const options = nodes
        .filter((n) => !currentTyping || n.name.toLowerCase().includes(lp))
        .map((n) => ({
          label: n.name,
          detail: n.description || undefined,
          apply: `${prefix}${n.name}${n.children ? ' ' : ''}`,
        }));

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
        return (
          c.name.toLowerCase().includes(lp) ||
          c.description.toLowerCase().includes(lp)
        );
      })
      .map((c) => ({
        label: `/${c.name}`,
        detail: c.description || undefined,
        apply: `/${c.name}${c.argumentHint || c.subcommands?.length ? ' ' : ''}`,
      }));

    if (options.length === 0) return null;

    return {
      from: line.from,
      options,
      filter: false,
    };
  };
}
