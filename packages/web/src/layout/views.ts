export type WebViewId =
  | 'chat'
  | 'sessions'
  | 'files'
  | 'artifacts'
  | 'mcp'
  | 'tools'
  | 'skills'
  | 'memory'
  | 'settings';

export interface WebViewDefinition {
  id: WebViewId;
  label: string;
  description: string;
}

export const WEB_VIEWS: WebViewDefinition[] = [
  {
    id: 'chat',
    label: '首页',
    description: '开始一个任务',
  },
  {
    id: 'sessions',
    label: '会话',
    description: '历史对话',
  },
  {
    id: 'files',
    label: '文件',
    description: '工作区文件',
  },
  {
    id: 'artifacts',
    label: '产物',
    description: '文件活动',
  },
  {
    id: 'mcp',
    label: 'MCP',
    description: '服务与工具',
  },
  {
    id: 'tools',
    label: '工具',
    description: '工具开关',
  },
  {
    id: 'skills',
    label: '技能',
    description: '可用技能',
  },
  {
    id: 'memory',
    label: '记忆',
    description: '项目记忆',
  },
  {
    id: 'settings',
    label: '设置',
    description: '运行配置',
  },
];
