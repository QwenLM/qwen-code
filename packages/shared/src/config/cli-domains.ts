export type CliDomainNamespace = 'label' | 'source' | 'skill' | 'automation' | 'permission' | 'theme'

export interface CliDomainPolicy {
  namespace: CliDomainNamespace
  helpCommand: string
  workspacePathScopes: string[]
  readActions: string[]
  quickExamples: string[]
  /** Optional workspace-relative paths guarded for direct Bash operations */
  bashGuardPaths?: string[]
}

const POLICIES: Record<CliDomainNamespace, CliDomainPolicy> = {
  label: {
    namespace: 'label',
    helpCommand: 'craft-agent label --help',
    workspacePathScopes: ['labels/**'],
    readActions: ['list', 'get', 'auto-rule-list', 'auto-rule-validate'],
    quickExamples: [
      'craft-agent label list',
      'craft-agent label create --name "Bug" --color "accent"',
      'craft-agent label update bug --json \'{"name":"Bug Report"}\'',
    ],
    bashGuardPaths: ['labels/**'],
  },
  source: {
    namespace: 'source',
    helpCommand: 'craft-agent source --help',
    workspacePathScopes: ['sources/**'],
    readActions: ['list', 'get', 'validate', 'test', 'auth-help'],
    quickExamples: [
      'craft-agent source list',
      'craft-agent source get <slug>',
      'craft-agent source update <slug> --json "{...}"',
      'craft-agent source validate <slug>',
    ],
  },
  skill: {
    namespace: 'skill',
    helpCommand: 'craft-agent skill --help',
    workspacePathScopes: ['skills/**'],
    readActions: ['list', 'get', 'validate', 'where'],
    quickExamples: [
      'craft-agent skill list',
      'craft-agent skill get <slug>',
      'craft-agent skill update <slug> --json "{...}"',
      'craft-agent skill validate <slug>',
    ],
  },
  automation: {
    namespace: 'automation',
    helpCommand: 'craft-agent automation --help',
    workspacePathScopes: ['automations.json', 'automations-history.jsonl'],
    readActions: ['list', 'get', 'validate', 'history', 'last-executed', 'test', 'lint'],
    quickExamples: [
      'craft-agent automation list',
      'craft-agent automation create --event UserPromptSubmit --prompt "Summarize this prompt"',
      'craft-agent automation update <id> --json "{\"enabled\":false}"',
      'craft-agent automation history <id> --limit 20',
      'craft-agent automation validate',
    ],
    bashGuardPaths: ['automations.json', 'automations-history.jsonl'],
  },
  permission: {
    namespace: 'permission',
    helpCommand: 'craft-agent permission --help',
    workspacePathScopes: ['permissions.json', 'sources/*/permissions.json'],
    readActions: ['list', 'get', 'validate'],
    quickExamples: [
      'craft-agent permission list',
      'craft-agent permission get --source linear',
      'craft-agent permission add-mcp-pattern "list" --comment "All list ops" --source linear',
      'craft-agent permission validate',
    ],
    bashGuardPaths: ['permissions.json', 'sources/*/permissions.json'],
  },
  theme: {
    namespace: 'theme',
    helpCommand: 'craft-agent theme --help',
    workspacePathScopes: ['config.json', 'theme.json', 'themes/*.json'],
    readActions: ['get', 'validate', 'list-presets', 'get-preset'],
    quickExamples: [
      'craft-agent theme get',
      'craft-agent theme list-presets',
      'craft-agent theme set-color-theme nord',
      'craft-agent theme set-workspace-color-theme default',
      'craft-agent theme set-override --json "{\"accent\":\"#3b82f6\"}"',
    ],
    bashGuardPaths: ['config.json', 'theme.json', 'themes/*.json'],
  },
}

export const CLI_DOMAIN_POLICIES = POLICIES

export interface CliDomainScopeEntry {
  namespace: CliDomainNamespace
  scope: string
}

function dedupeScopes(scopes: string[]): string[] {
  return [...new Set(scopes)]
}

/**
 * Canonical workspace-relative path scopes owned by craft-agent CLI domains.
 * Use these for file-path ownership checks to avoid drift across call sites.
 */
export const CRAFT_AGENTS_CLI_OWNED_WORKSPACE_PATH_SCOPES = dedupeScopes(
  Object.values(POLICIES).flatMap(policy => policy.workspacePathScopes)
)

/**
 * Canonical workspace-relative path scopes guarded for direct Bash operations.
 */
export const CRAFT_AGENTS_CLI_OWNED_BASH_GUARD_PATH_SCOPES = dedupeScopes(
  Object.values(POLICIES).flatMap(policy => policy.bashGuardPaths ?? [])
)

/**
 * Namespace-aware workspace scope entries for craft-agent CLI owned paths.
 */
export const CRAFT_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES: CliDomainScopeEntry[] = Object.values(POLICIES)
  .flatMap(policy => policy.workspacePathScopes.map(scope => ({ namespace: policy.namespace, scope })))

/**
 * Namespace-aware Bash guard scope entries.
 */
export const CRAFT_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES: CliDomainScopeEntry[] = Object.values(POLICIES)
  .flatMap(policy => (policy.bashGuardPaths ?? []).map(scope => ({ namespace: policy.namespace, scope })))

export interface BashPatternRule {
  pattern: string
  comment: string
}

/**
 * Derive the canonical Plan-mode read-only craft-agent bash patterns from
 * CLI domain policies. Keeps permissions regexes aligned with command metadata.
 */
export function getCraftAgentReadOnlyBashPatterns(): BashPatternRule[] {
  const namespaces = Object.keys(POLICIES) as CliDomainNamespace[]
  const namespaceAlternation = namespaces.join('|')

  const rules: BashPatternRule[] = namespaces.map((namespace) => {
    const policy = POLICIES[namespace]
    const actions = policy.readActions.join('|')
    return {
      pattern: `^craft-agent\\s+${namespace}\\s+(${actions})\\b`,
      comment: `craft-agent ${namespace} read-only operations`,
    }
  })

  rules.push(
    { pattern: '^craft-agent\\s*$', comment: 'craft-agent bare invocation (prints help)' },
    { pattern: `^craft-agent\\s+(${namespaceAlternation})\\s*$`, comment: 'craft-agent entity help' },
    { pattern: `^craft-agent\\s+(${namespaceAlternation})\\s+--help\\b`, comment: 'craft-agent entity help flags' },
    { pattern: '^craft-agent\\s+--(help|version|discover)\\b', comment: 'craft-agent global flags' },
  )

  return rules
}

export function getCliDomainPolicy(namespace: CliDomainNamespace): CliDomainPolicy {
  return POLICIES[namespace]
}
