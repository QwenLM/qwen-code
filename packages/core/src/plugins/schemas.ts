/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

/**
 * Reserved namespaces in the existing managed-installation protocol.
 * Ordinary marketplace manifests must not claim these namespaces.
 */
export const ENTERPRISE_MARKETPLACE_PREFIXES = [
  'qoder-enterprise-',
  'qoderwork-enterprise-',
] as const;

// ---------------------------------------------------------------------------
// Helper: Relative path validators
// ---------------------------------------------------------------------------

const RelativePath = z
  .string()
  .min(1)
  .refine((p) => p.startsWith('./'), {
    message: 'Path must start with ./',
  });

const RelativeJSONPath = RelativePath.refine((p) => p.endsWith('.json'), {
  message: 'Path must end with .json',
});

const RelativeMarkdownPath = RelativePath.refine((p) => p.endsWith('.md'), {
  message: 'Path must end with .md',
});

const RelativeCommandPath = RelativePath; // Commands can be .md files or directories

// ---------------------------------------------------------------------------
// Marketplace name protection
// ---------------------------------------------------------------------------

/**
 * Official marketplace names reserved for the platform.
 * Third parties cannot use these names.
 */
export const ALLOWED_OFFICIAL_MARKETPLACE_NAMES = new Set([
  'qoder-marketplace',
  'qoder-plugins',
  'qoder-plugins-official',
]);

/**
 * Pattern to detect names that impersonate official marketplaces.
 */
export const BLOCKED_OFFICIAL_NAME_PATTERN =
  /(?:official[^a-z0-9]*(qoder)|(?:qoder)[^a-z0-9]*official|^(?:qoder)[^a-z0-9]*(marketplace|plugins|official))/i;

const NON_ASCII_PATTERN = /[^\u0020-\u007E]/;

/**
 * Check if a marketplace name impersonates an official marketplace.
 */
export function isBlockedOfficialName(name: string): boolean {
  if (ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(name.toLowerCase())) {
    return false;
  }
  if (NON_ASCII_PATTERN.test(name)) {
    return true;
  }
  return BLOCKED_OFFICIAL_NAME_PATTERN.test(name);
}

/**
 * Marketplace name schema with validation.
 */
export const MarketplaceNameSchema = z
  .string()
  .min(1, 'Marketplace name cannot be empty')
  .max(100, 'Marketplace name too long')
  .regex(
    /^[a-z0-9][-a-z0-9._]*$/i,
    'Must start with alphanumeric, only contain alphanumeric, hyphens, dots, underscores',
  )
  .refine((name) => !name.includes(' '), {
    message: 'Marketplace name cannot contain spaces',
  })
  .refine((name) => !isBlockedOfficialName(name), {
    message:
      'This name is reserved or impersonates an official marketplace. Choose a different name.',
  })
  .refine((name) => name.toLowerCase() !== 'inline', {
    message: '"inline" is a reserved marketplace name',
  })
  .refine((name) => name.toLowerCase() !== 'builtin', {
    message: '"builtin" is a reserved marketplace name',
  })
  .refine((name) => name.toLowerCase() !== 'local', {
    message: '"local" is a reserved marketplace name',
  })
  .refine((name) => name.toLowerCase() !== 'flag', {
    message: '"flag" is a reserved marketplace name',
  })
  .refine(
    (name) => {
      const lower = name.toLowerCase();
      return !ENTERPRISE_MARKETPLACE_PREFIXES.some((p) =>
        lower.startsWith(p),
      );
    },
    {
      message: `"${ENTERPRISE_MARKETPLACE_PREFIXES.join('*", "')}*" are reserved namespaces for enterprise-managed plugins`,
    },
  );

// ---------------------------------------------------------------------------
// Plugin author
// ---------------------------------------------------------------------------

export const PluginAuthorSchema = z.object({
  name: z.string().min(1).describe('Author or organization name'),
  email: z.string().optional().describe('Contact email'),
  url: z.string().optional().describe('Author website or profile'),
});

// ---------------------------------------------------------------------------
// Dependency references (must be before PluginManifestMetadataSchema)
// ---------------------------------------------------------------------------

const DEP_REF_REGEX =
  /^[a-z0-9][-a-z0-9._]*(@[a-z0-9][-a-z0-9._]*)?(@\^[^@]*)?$/i;

/**
 * Schema for entries in a plugin's `dependencies` array.
 *
 * Accepts:
 *   "plugin"              → bare, resolved against declaring plugin's marketplace
 *   "plugin@marketplace"  → qualified
 *   "plugin@mkt@^1.2"    → trailing @^version silently stripped
 */
export const DependencyRefSchema = z.union([
  z
    .string()
    .regex(
      DEP_REF_REGEX,
      'Dependency must be a plugin name, optionally qualified with @marketplace',
    )
    .transform((s) => s.replace(/@\^[^@]*$/, '')),
  z
    .object({
      name: z
        .string()
        .min(1)
        .regex(/^[a-z0-9][-a-z0-9._]*$/i),
      marketplace: z
        .string()
        .min(1)
        .regex(/^[a-z0-9][-a-z0-9._]*$/i)
        .optional(),
    })
    .passthrough()
    .transform((o) => (o.marketplace ? `${o.name}@${o.marketplace}` : o.name)),
]);

// ---------------------------------------------------------------------------
// Plugin manifest metadata
// ---------------------------------------------------------------------------

const PluginManifestMetadataSchema = z.object({
  name: z
    .string()
    .min(1, 'Plugin name cannot be empty')
    .refine((name) => !name.includes(' '), {
      message:
        'Plugin name cannot contain spaces. Use kebab-case (e.g., "my-plugin")',
    })
    .describe('Unique plugin identifier'),
  version: z.string().optional().describe('Semantic version (e.g., 1.0.0)'),
  displayName: z
    .string()
    .optional()
    .describe('Human-readable display name for UI surfaces'),
  description: z.string().optional().describe('Brief plugin description'),
  author: PluginAuthorSchema.optional().describe('Plugin author information'),
  homepage: z
    .string()
    .url()
    .optional()
    .describe('Plugin homepage or documentation URL'),
  repository: z.string().optional().describe('Source code repository URL'),
  license: z
    .string()
    .optional()
    .describe('SPDX license identifier (e.g., MIT, Apache-2.0)'),
  keywords: z
    .array(z.string())
    .optional()
    .describe('Tags for plugin discovery and categorization'),
  dependencies: z
    .array(DependencyRefSchema)
    .optional()
    .describe(
      "Plugins that must be enabled for this plugin to function. Bare names resolve against the declaring plugin's own marketplace.",
    ),
});

// ---------------------------------------------------------------------------
// Plugin hooks
// ---------------------------------------------------------------------------

/**
 * Schema for plugin hooks configuration (hooks.json).
 *
 * The hooks field accepts the same format as the settings-level hooks config,
 * mapping HookEventName to arrays of HookDefinition.
 * We use z.record here since the actual HookDefinition validation happens
 * at the hook system level.
 */
export const PluginHooksConfigSchema = z
  .record(z.string(), z.array(z.record(z.string(), z.unknown())))
  .describe('Hook event name to hook definitions mapping');

export const PluginHooksSchema = z.object({
  description: z
    .string()
    .optional()
    .describe('Brief explanation of what these hooks provide'),
  hooks: PluginHooksConfigSchema.describe('The hooks provided by the plugin'),
});

const PluginManifestHooksSchema = z
  .object({
    hooks: z.union([
      RelativeJSONPath.describe('Path to additional hooks JSON file'),
      PluginHooksConfigSchema.describe('Inline hooks configuration'),
      z
        .array(
          z.union([
            RelativeJSONPath.describe('Path to additional hooks JSON file'),
            PluginHooksConfigSchema.describe('Inline hooks configuration'),
          ]),
        )
        .describe('Array of hooks configurations'),
    ]),
  })
  .partial();

// ---------------------------------------------------------------------------
// Plugin commands
// ---------------------------------------------------------------------------

/**
 * Schema for command metadata when using object-mapping format.
 */
export const CommandMetadataSchema = z
  .object({
    source: RelativeCommandPath.optional().describe(
      'Path to command markdown file, relative to plugin root',
    ),
    content: z
      .string()
      .optional()
      .describe('Inline markdown content for the command'),
    description: z.string().optional().describe('Command description override'),
    argumentHint: z
      .string()
      .optional()
      .describe('Hint for command arguments (e.g., "[file]")'),
    model: z.string().optional().describe('Default model for this command'),
    allowedTools: z
      .array(z.string())
      .optional()
      .describe('Tools allowed when command runs'),
    context: z
      .enum(['fork', 'inline'])
      .optional()
      .describe(
        'Execution context: "inline" (default) injects content into the current conversation; "fork" runs in an isolated sub-agent.',
      ),
    arguments: z
      .array(z.string())
      .optional()
      .describe('Named argument definitions for $name substitution.'),
    effort: z
      .string()
      .optional()
      .describe('Reasoning effort override (low/medium/high/max or integer).'),
    agent: z
      .string()
      .optional()
      .describe('Sub-agent type to use when context is "fork".'),
  })
  .refine(
    (data) => (data.source && !data.content) || (!data.source && data.content),
    {
      message:
        'Command must have either "source" (file path) or "content" (inline markdown), but not both',
    },
  );

const PluginManifestCommandsSchema = z
  .object({
    commands: z.union([
      RelativeCommandPath.describe(
        'Path to additional command file or directory',
      ),
      z
        .array(RelativeCommandPath)
        .describe('List of paths to additional command files or directories'),
      z
        .record(z.string(), CommandMetadataSchema)
        .describe(
          'Object mapping of command names to metadata. Command name becomes the slash command name.',
        ),
    ]),
  })
  .partial();

// ---------------------------------------------------------------------------
// Plugin agents
// ---------------------------------------------------------------------------

const PluginManifestAgentsSchema = z
  .object({
    agents: z.union([
      RelativeMarkdownPath.describe('Path to additional agent file'),
      z
        .array(RelativeMarkdownPath)
        .describe('List of paths to additional agent files'),
    ]),
  })
  .partial();

// ---------------------------------------------------------------------------
// Plugin skills
// ---------------------------------------------------------------------------

const PluginManifestSkillsSchema = z
  .object({
    skills: z.union([
      RelativePath.describe('Path to additional skill directory'),
      z
        .array(RelativePath)
        .describe('List of paths to additional skill directories'),
    ]),
  })
  .partial();

// ---------------------------------------------------------------------------
// Plugin output styles
// ---------------------------------------------------------------------------

const PluginManifestOutputStylesSchema = z
  .object({
    outputStyles: z.union([
      RelativePath.describe(
        'Path to additional output styles directory or file',
      ),
      z
        .array(RelativePath)
        .describe(
          'List of paths to additional output styles directories or files',
        ),
    ]),
  })
  .partial();

// ---------------------------------------------------------------------------
// Plugin workflows
// ---------------------------------------------------------------------------

const PluginManifestWorkflowsSchema = z
  .object({
    workflowsPath: RelativePath.describe(
      'Path to an additional workflow file or directory',
    ).optional(),
    workflowsPaths: z
      .array(RelativePath)
      .describe('List of workflow files or directories')
      .optional(),
  })
  .partial();

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

/**
 * MCP server configuration schema.
 * We intentionally keep this loose since the real MCPServerConfig class
 * handles detailed validation.
 */
export const McpServerConfigSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough(); // Allow additional MCP config fields

const PluginManifestMcpServerSchema = z
  .object({
    mcpServers: z.union([
      RelativeJSONPath.describe('Path to MCP servers configuration file'),
      z
        .record(z.string(), McpServerConfigSchema)
        .describe('MCP server configurations keyed by server name'),
      z
        .array(
          z.union([
            RelativeJSONPath.describe('Path to MCP servers configuration file'),
            z
              .record(z.string(), McpServerConfigSchema)
              .describe('Inline MCP server configurations'),
          ]),
        )
        .describe('Array of MCP server configurations'),
    ]),
  })
  .partial();

// ---------------------------------------------------------------------------
// Plugin settings
// ---------------------------------------------------------------------------

const PluginManifestSettingsSchema = z
  .object({
    settings: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Settings to merge when plugin is enabled. Only allowlisted keys are kept.',
      ),
  })
  .partial();

/**
 * Fields recognized from other CLI implementations but not yet implemented.
 * Accepted to avoid hard validation errors; ignored at runtime with a warning.
 */
const PluginManifestForeignSchema = z
  .object({
    lspServers: z
      .unknown()
      .optional()
      .describe(
        'LSP server configurations (recognized but not yet implemented)',
      ),
    channels: z
      .unknown()
      .optional()
      .describe(
        'MCP channel configurations (recognized but not yet implemented)',
      ),
  })
  .partial();

/**
 * Set of manifest fields that are recognized but not yet implemented.
 * Derived from PluginManifestForeignSchema so adding a new foreign field
 * only requires touching the schema definition above.
 *
 * Used by validation and loader to emit warnings instead of errors.
 */
export const RECOGNIZED_BUT_UNIMPLEMENTED_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(PluginManifestForeignSchema.shape),
);

// ---------------------------------------------------------------------------
// Plugin manifest (plugin.json) — the main schema
// ---------------------------------------------------------------------------

/**
 * Plugin manifest file (plugin.json).
 *
 * Validates the structure of plugin manifests and provides runtime
 * type checking when loading plugins from disk.
 *
 * Unknown top-level fields are silently stripped (zod default).
 * Nested config objects remain strict.
 */
export const PluginManifestSchema = z.object({
  ...PluginManifestMetadataSchema.shape,
  ...PluginManifestHooksSchema.shape,
  ...PluginManifestCommandsSchema.shape,
  ...PluginManifestAgentsSchema.shape,
  ...PluginManifestSkillsSchema.shape,
  ...PluginManifestOutputStylesSchema.shape,
  ...PluginManifestWorkflowsSchema.shape,
  ...PluginManifestMcpServerSchema.shape,
  ...PluginManifestSettingsSchema.shape,
  ...PluginManifestForeignSchema.shape,
});

// ---------------------------------------------------------------------------
// Plugin ID
// ---------------------------------------------------------------------------

/**
 * Plugin ID format: "plugin-name@marketplace-name"
 */
export const PluginIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][-a-z0-9._]*@[a-z0-9][-a-z0-9._]*$/i,
    'Plugin ID must be in format: plugin@marketplace',
  );

/**
 * Read compatibility for legacy QoderCLI state written before marketplace
 * sources were normalized to the manifest-declared name. Some of those
 * records use a source-like marketplace segment such as "owner/repo".
 *
 * Keep this deliberately local to persisted installed-plugin files: slash
 * marketplace IDs are migration input, not part of the public PluginId
 * contract and must never be produced by new writes.
 */
const PersistedPluginIdSchema = z.union([
  PluginIdSchema,
  z
    .string()
    .regex(
      /^[a-z0-9][-a-z0-9._]*@[a-z0-9][-a-z0-9._]*(?:\/[a-z0-9][-a-z0-9._]*)+$/i,
      'Persisted plugin ID must be canonical or a supported legacy alias',
    ),
]);

// (DependencyRefSchema moved above PluginManifestMetadataSchema)

// ---------------------------------------------------------------------------
// Plugin source (for marketplace entries)
// ---------------------------------------------------------------------------

const NpmPackageNameSchema = z
  .string()
  .refine(
    (name) => !name.includes('..') && !name.includes('//'),
    'Package name cannot contain path traversal patterns',
  )
  .refine((name) => {
    const scopedPackageRegex = /^@[a-z0-9][a-z0-9-._]*\/[a-z0-9][a-z0-9-._]*$/;
    const regularPackageRegex = /^[a-z0-9][a-z0-9-._]*$/;
    return scopedPackageRegex.test(name) || regularPackageRegex.test(name);
  }, 'Invalid npm package name format');

const gitSha = z
  .string()
  .length(40)
  .regex(
    /^[a-f0-9]{40}$/,
    'Must be a full 40-character lowercase git commit SHA',
  );

export const Sha256HexSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{64}$/, 'Must be a 64-character hex SHA256 digest')
  .transform((hex) => hex.toLowerCase());

export const PluginSourceSchema = z.union([
  RelativePath.describe('Path relative to marketplace root'),
  z.object({
    source: z.literal('archive'),
    url: z.string().url().describe('Direct download URL of the plugin ZIP'),
    sha256: Sha256HexSchema.describe('SHA256 of the raw ZIP bytes'),
  }),
  z.object({
    source: z.literal('npm'),
    package: NpmPackageNameSchema.or(z.string()).describe('NPM package name'),
    version: z.string().optional().describe('Version or version range'),
    registry: z.string().url().optional().describe('Custom NPM registry URL'),
  }),
  z.object({
    source: z.literal('pip'),
    package: z.string().describe('Python package name as it appears on PyPI'),
    version: z
      .string()
      .optional()
      .describe('Version specifier (e.g., ==1.0.0, >=2.0.0, <3.0.0)'),
    registry: z.string().url().optional().describe('Custom PyPI registry URL'),
  }),
  z.object({
    source: z.literal('url'),
    url: z.string().describe('Full git repository URL'),
    ref: z.string().optional().describe('Git branch or tag'),
    sha: gitSha.optional().describe('Specific commit SHA'),
  }),
  z.object({
    source: z.literal('github'),
    repo: z.string().describe('GitHub repository in owner/repo format'),
    ref: z.string().optional().describe('Git branch or tag'),
    sha: gitSha.optional().describe('Specific commit SHA'),
  }),
  z.object({
    source: z.literal('git-subdir'),
    url: z.string().describe('Git repository URL'),
    path: z.string().min(1).describe('Subdirectory within the repo'),
    ref: z.string().optional().describe('Git branch or tag'),
    sha: gitSha.optional().describe('Specific commit SHA'),
  }),
]);

/**
 * Check if a plugin source is a local path (stored in marketplace directory).
 */
export function isLocalPluginSource(source: PluginSource): source is string {
  return typeof source === 'string' && source.startsWith('./');
}

// ---------------------------------------------------------------------------
// Marketplace source
// ---------------------------------------------------------------------------

export const MarketplaceSourceSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('url'),
    url: z.string().url().describe('Direct URL to marketplace.json'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('Custom HTTP headers'),
  }),
  z.object({
    source: z.literal('github'),
    repo: z.string().describe('GitHub repository in owner/repo format'),
    ref: z.string().optional().describe('Git branch or tag'),
    path: z
      .string()
      .optional()
      .describe(
        'Path within repo: a directory containing marketplace.json, or full path to a .json file',
      ),
    sparsePaths: z
      .array(z.string())
      .optional()
      .describe('Sparse-checkout paths for monorepo support'),
  }),
  z.object({
    source: z.literal('git'),
    url: z.string().describe('Full git repository URL'),
    ref: z.string().optional().describe('Git branch or tag'),
    path: z
      .string()
      .optional()
      .describe(
        'Path within repo: a directory containing marketplace.json, or full path to a .json file',
      ),
    sparsePaths: z
      .array(z.string())
      .optional()
      .describe('Sparse-checkout paths for monorepo support'),
  }),
  z.object({
    source: z.literal('npm'),
    package: NpmPackageNameSchema.describe(
      'NPM package containing marketplace.json',
    ),
  }),
  z.object({
    source: z.literal('file'),
    path: z.string().describe('Local file path to marketplace.json'),
  }),
  z.object({
    source: z.literal('directory'),
    path: z.string().describe('Local directory containing plugin marketplace'),
  }),
  z.object({
    source: z.literal('hostPattern'),
    hostPattern: z
      .string()
      .min(1)
      .describe('Regex pattern for host-matching in strictKnownMarketplaces'),
  }),
  z.object({
    source: z.literal('pathPattern'),
    pathPattern: z
      .string()
      .min(1)
      .describe('Regex pattern for filesystem path matching'),
  }),
  z.object({
    source: z.literal('settings'),
    name: z.string().min(1).describe('Inline marketplace name'),
    plugins: z.array(z.unknown()).describe('Inline plugin entries'),
    owner: PluginAuthorSchema.optional().describe('Marketplace maintainer'),
  }),
]);

/**
 * Whether a marketplace source points at a local filesystem path.
 */
export function isLocalMarketplaceSource(
  source: MarketplaceSource,
): source is Extract<MarketplaceSource, { source: 'file' | 'directory' }> {
  return source.source === 'file' || source.source === 'directory';
}

// ---------------------------------------------------------------------------
// Marketplace entry (a plugin listing in a marketplace)
// ---------------------------------------------------------------------------

export const PluginMarketplaceEntrySchema =
  PluginManifestSchema.partial().extend({
    name: z
      .string()
      .min(1, 'Plugin name cannot be empty')
      .refine((name) => !name.includes(' '), {
        message: 'Plugin name cannot contain spaces',
      })
      .describe('Unique identifier matching the plugin name'),
    source: PluginSourceSchema.describe('Where to fetch the plugin from'),
    category: z.string().optional().describe('Category for organizing plugins'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Tags for searchability and discovery'),
    strict: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'Require plugin manifest in the plugin folder. If false, marketplace entry provides the manifest.',
      ),
  });

// ---------------------------------------------------------------------------
// Marketplace manifest (marketplace.json)
// ---------------------------------------------------------------------------

export const PluginMarketplaceSchema = z.object({
  name: MarketplaceNameSchema,
  owner: PluginAuthorSchema.describe('Marketplace maintainer information'),
  plugins: z
    .array(PluginMarketplaceEntrySchema)
    .describe('Collection of available plugins'),
  forceRemoveDeletedPlugins: z
    .boolean()
    .optional()
    .describe(
      'When true, plugins removed from this marketplace will be automatically uninstalled',
    ),
  metadata: z
    .object({
      pluginRoot: z
        .string()
        .optional()
        .describe('Base path for relative plugin sources'),
      version: z.string().optional().describe('Marketplace version'),
      description: z.string().optional().describe('Marketplace description'),
    })
    .optional()
    .describe('Optional marketplace metadata'),
  allowCrossMarketplaceDependenciesOn: z
    .array(z.string())
    .optional()
    .describe(
      'Marketplace names whose plugins may be auto-installed as dependencies.',
    ),
});

// ---------------------------------------------------------------------------
// Installed plugins state
// ---------------------------------------------------------------------------

export const PluginScopeSchema = z.enum([
  'managed',
  'user',
  'project',
  'local',
]);

export const InstalledPluginSchema = z.object({
  version: z.string().describe('Currently installed version'),
  installedAt: z.string().describe('ISO 8601 timestamp of installation'),
  lastUpdated: z
    .string()
    .optional()
    .describe('ISO 8601 timestamp of last update'),
  installPath: z
    .string()
    .describe('Absolute path to the installed plugin directory'),
  gitCommitSha: z
    .string()
    .optional()
    .describe('Git commit SHA for git-based plugins'),
});

export const PluginInstallationEntrySchema = z.object({
  scope: PluginScopeSchema.describe('Installation scope'),
  projectPath: z
    .string()
    .optional()
    .describe('Project path (required for project/local scopes)'),
  installPath: z
    .string()
    .describe('Absolute path to the versioned plugin directory'),
  version: z.string().optional().describe('Currently installed version'),
  installedAt: z
    .string()
    .optional()
    .describe('ISO 8601 timestamp of installation'),
  lastUpdated: z
    .string()
    .optional()
    .describe('ISO 8601 timestamp of last update'),
  gitCommitSha: z
    .string()
    .optional()
    .describe('Git commit SHA for git-based plugins'),
  // Enterprise plugin (scope=managed) metadata. All optional; only populated
  // on managed entries.
  orgId: z
    .string()
    .optional()
    .describe('Organization ID this enterprise plugin belongs to'),
  displayName: z
    .string()
    .optional()
    .describe('Human-readable display name for enterprise plugins'),
  userVisible: z
    .boolean()
    .optional()
    .describe(
      'Whether this enterprise plugin appears in user-facing plugin lists. Persisted entry: missing → treated as visible (true).',
    ),
  userCanDisable: z
    .boolean()
    .optional()
    .describe(
      'Whether the user is allowed to disable this enterprise plugin. Persisted entry: missing → treated as user-toggleable (true).',
    ),
  fileHash: z
    .string()
    .optional()
    .describe(
      'Stored as "sha256:..." string from the API; used for hash diff on next sync',
    ),
  fileSize: z
    .number()
    .optional()
    .describe('Downloaded zip size in bytes (informational)'),
})
  // Preserve unknown, sibling-owned fields (e.g. the IDE's `source` marker) on
  // load so a subsequent whole-state rewrite in `saveInstalledPluginsToDisk`
  // doesn't silently drop them. Without this, Zod's default strip discards any
  // field the CLI doesn't model, permanently losing it on the next
  // install/uninstall/update.
  .passthrough();

export const InstalledPluginsFileSchemaV1 = z.object({
  version: z.literal(1).describe('Schema version 1'),
  plugins: z
    .record(PersistedPluginIdSchema, InstalledPluginSchema)
    .describe('Map of plugin IDs to their installation metadata'),
});

export const InstalledPluginsFileSchemaV2 = z.object({
  version: z.literal(2).describe('Schema version 2'),
  plugins: z
    .record(PersistedPluginIdSchema, z.array(PluginInstallationEntrySchema))
    .describe('Map of plugin IDs to arrays of installation entries'),
});

export const InstalledPluginsFileSchema = z.union([
  InstalledPluginsFileSchemaV1,
  InstalledPluginsFileSchemaV2,
]);

// ---------------------------------------------------------------------------
// Known marketplaces state
// ---------------------------------------------------------------------------

export const KnownMarketplaceSchema = z.object({
  source: MarketplaceSourceSchema.describe(
    'Where to fetch the marketplace from',
  ),
  installLocation: z
    .string()
    .describe('Local cache path where marketplace manifest is stored'),
  lastUpdated: z
    .string()
    .describe('ISO 8601 timestamp of last marketplace refresh'),
  autoUpdate: z
    .boolean()
    .optional()
    .describe(
      'Whether to automatically refresh this marketplace data and update its installed plugins in the background. Declared source changes are still reconciled at startup.',
    ),
});

export const KnownMarketplacesFileSchema = z.record(
  z.string(),
  KnownMarketplaceSchema,
);



// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type CommandMetadata = z.infer<typeof CommandMetadataSchema>;
export type MarketplaceSource = z.infer<typeof MarketplaceSourceSchema>;
export type PluginAuthor = z.infer<typeof PluginAuthorSchema>;
export type PluginSource = z.infer<typeof PluginSourceSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginMarketplace = z.infer<typeof PluginMarketplaceSchema>;
export type PluginMarketplaceEntry = z.infer<
  typeof PluginMarketplaceEntrySchema
>;
export type PluginId = z.infer<typeof PluginIdSchema>;
export type PluginScope = z.infer<typeof PluginScopeSchema>;
export type PluginInstallationEntry = z.infer<
  typeof PluginInstallationEntrySchema
>;
export type KnownMarketplacesFile = z.infer<typeof KnownMarketplacesFileSchema>;
