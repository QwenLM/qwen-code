/**
 * Documentation links and summaries for contextual help throughout the UI.
 * Summaries provide quick context; "Learn more" opens the full docs.
 */

const DOC_BASE_URL = 'https://agents.craft.do/docs'

export type DocFeature =
  | 'sources'
  | 'sources-api'
  | 'sources-mcp'
  | 'sources-local'
  | 'skills'
  | 'statuses'
  | 'permissions'
  | 'labels'
  | 'workspaces'
  | 'themes'
  | 'app-settings'
  | 'preferences'
  | 'automations'

export interface DocInfo {
  /** Path relative to DOC_BASE_URL */
  path: string
  /** Display title for the help popover */
  title: string
  /** 1-2 sentence summary for quick context */
  summary: string
}

export const DOCS: Record<DocFeature, DocInfo> = {
  sources: {
    path: '/sources/overview',
    title: 'Sources',
    summary:
      'Connect external data like MCP servers, REST APIs, and local filesystems. Sources give your agent tools to access services like GitHub, Linear, or your Obsidian vault.',
  },
  'sources-api': {
    path: '/sources/apis/overview',
    title: 'APIs',
    summary:
      'Connect to any REST API with flexible authentication. Make HTTP requests to external services directly from your conversations.',
  },
  'sources-mcp': {
    path: '/sources/mcp-servers/overview',
    title: 'MCP Servers',
    summary:
      'Connect to Model Context Protocol servers for rich tool integrations. MCP servers provide structured access to services like GitHub, Linear, and Notion.',
  },
  'sources-local': {
    path: '/sources/local-filesystems',
    title: 'Local Folders',
    summary:
      'Give your agent access to local directories like Obsidian vaults, code repositories, or data folders on your machine.',
  },
  skills: {
    path: '/skills/overview',
    title: 'Skills',
    summary:
      'Reusable instruction sets that teach your agent specialized behaviors. Create a SKILL.md file and invoke it with @mention in your messages.',
  },
  statuses: {
    path: '/statuses/overview',
    title: 'Statuses',
    summary:
      'Organize conversations into workflow states like Todo, In Progress, and Done. Open statuses appear in your inbox; closed ones move to the archive.',
  },
  permissions: {
    path: '/core-concepts/permissions',
    title: 'Permissions',
    summary:
      'Control how much autonomy your agent has. Plan mode is plan-first, Ask before edits prompts before changes, Edit automatically applies edits, and YOLO runs without prompts.',
  },
  labels: {
    path: '/labels/overview',
    title: 'Labels',
    summary:
      'Tag sessions with colored labels for organization and filtering. Labels support hierarchical nesting, typed values, and auto-apply rules that extract data from messages using regex patterns.',
  },
  workspaces: {
    path: '/go-further/workspaces',
    title: 'Workspaces',
    summary:
      'Separate configurations for different contexts like personal projects or work. Each workspace has its own sources, skills, statuses, and session history.',
  },
  themes: {
    path: '/go-further/themes',
    title: 'Themes',
    summary:
      'Customize the visual appearance with a 6-color system. Override specific colors in theme.json or install preset themes for complete visual styles.',
  },
  'app-settings': {
    path: '/reference/config/config-file',
    title: 'App Settings',
    summary:
      'Configure global app settings like your default model, authentication method, and workspace list. Settings are stored in ~/.craft-agent/config.json.',
  },
  preferences: {
    path: '/reference/config/preferences',
    title: 'Preferences',
    summary:
      'Personal preferences like your name, timezone, and language that help the agent personalize responses. Stored in ~/.craft-agent/preferences.json.',
  },
  automations: {
    path: '/automations/overview',
    title: 'Automations',
    summary:
      'Automate actions when events occur — run commands on schedules, react to label changes, or trigger prompts. Configured in automations.json.',
  },
}

/**
 * Get the full documentation URL for a feature
 */
export function getDocUrl(feature: DocFeature): string {
  return `${DOC_BASE_URL}${DOCS[feature].path}`
}

/**
 * Get the doc info (title, summary, path) for a feature
 */
export function getDocInfo(feature: DocFeature): DocInfo {
  return DOCS[feature]
}
