/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { z } from 'zod';

import {
  PluginManifestSchema,
  RECOGNIZED_BUT_UNIMPLEMENTED_FIELDS,
} from '../schemas.js';
import {
  findManifestPath,
  loadPluginFromDirectory,
  PLUGIN_META_DIRS,
} from '../pluginLoader.js';
import { getPluginContentValidationError } from './pluginContentValidation.js';
import {
  collectPluginResources,
  type PluginResources,
} from '../loading/pluginResourceCollector.js';
import {
  getPluginErrorMessage,
  type LoadedPlugin,
  type PluginError,
} from '../types.js';
import { BRAND_CLI_BIN } from '../../config/brand.js';
import { getVersion } from '../../utils/version.js';
import { isPathContained } from '../../utils/pathContainment.js';
import { loadAgentsFromPath } from '../../agents/registry/agentLoader.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  success: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  filePath: string;
  fileType: 'plugin' | 'marketplace' | 'skill' | 'agent' | 'command' | 'hooks';
}

export interface ValidationError {
  path: string;
  message: string;
  code?: string;
}

export interface ValidationWarning {
  path: string;
  message: string;
  code?: string;
}

export type PluginValidationSeverity = 'error' | 'warning';
export type PluginValidationPhase =
  | 'target'
  | 'manifest'
  | 'component'
  | 'load-simulation'
  | 'installability';

export interface PluginValidationPosition {
  line: number;
  character: number;
}

export interface PluginValidationLocation {
  /** Plugin-root-relative path using forward slashes. */
  path: string;
  /** RFC 6901 pointer when the diagnostic targets a JSON value. */
  jsonPointer?: string;
  /** LSP-compatible, zero-based source range when available. */
  range?: {
    start: PluginValidationPosition;
    end: PluginValidationPosition;
  };
}

export interface PluginValidationDiagnostic {
  severity: PluginValidationSeverity;
  /** Stable, machine-readable code. Callers must tolerate unknown codes. */
  code: string;
  message: string;
  phase: PluginValidationPhase;
  location?: PluginValidationLocation;
  suggestion?: string;
}

export interface PluginValidationReport {
  schemaVersion: 1;
  validator: {
    name: string;
    version: string;
  };
  /** True when the complete report contains no error diagnostics. */
  valid: boolean;
  target: {
    inputPath: string;
    resolvedPath: string;
    manifestPath?: string;
  };
  plugin?: {
    name: string;
    version?: string;
    displayName?: string;
  };
  diagnostics: PluginValidationDiagnostic[];
  summary: {
    errorCount: number;
    warningCount: number;
    componentCount: number;
  };
  resources?: PluginResources;
}

/**
 * Fields that belong in marketplace.json entries but not plugin.json.
 * Surfaced as warnings — harmless at runtime but worth flagging to authors.
 */
const MARKETPLACE_ONLY_MANIFEST_FIELDS = new Set([
  'category',
  'source',
  'tags',
  'strict',
  'id',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatZodErrors(zodError: z.ZodError): ValidationError[] {
  return zodError.issues.map((issue) => ({
    path: issue.path.join('.') || 'root',
    message: issue.message,
    code: issue.code,
  }));
}

function checkPathTraversal(
  p: string,
  field: string,
  errors: ValidationError[],
): void {
  if (path.isAbsolute(p) || p.split(/[\\/]+/).includes('..')) {
    errors.push({
      path: field,
      message: `Path contains ".." which could be a path traversal attempt: ${p}`,
      code: 'plugin.path.outside_root',
    });
  }
}

function checkManifestPaths(
  manifest: Record<string, unknown>,
  errors: ValidationError[],
): void {
  const checkValue = (value: unknown, field: string) => {
    const values = Array.isArray(value) ? value : [value];
    for (const [index, item] of values.entries()) {
      if (typeof item === 'string') {
        checkPathTraversal(item, `${field}[${index}]`, errors);
      }
    }
  };

  for (const field of [
    'commands',
    'agents',
    'skills',
    'outputStyles',
    'workflowsPath',
    'workflowsPaths',
    'hooks',
    'mcpServers',
  ]) {
    checkValue(manifest[field], field);
  }

  const commands = manifest['commands'];
  if (commands && typeof commands === 'object' && !Array.isArray(commands)) {
    for (const [name, metadata] of Object.entries(commands)) {
      if (metadata && typeof metadata === 'object') {
        const source = (metadata as Record<string, unknown>)['source'];
        if (typeof source === 'string') {
          checkPathTraversal(source, `commands.${name}.source`, errors);
        }
      }
    }
  }
}

/**
 * Return a copy of `obj` with `fieldSet` keys removed, pushing a warning
 * for each removed key. If `obj` is not a plain object or has no matching
 * keys, the original value is returned unchanged.
 */
function stripFieldsWithWarnings(
  obj: unknown,
  fieldSet: ReadonlySet<string>,
  warningMessage: (key: string) => string,
  warnings: ValidationWarning[],
  code = 'plugin.manifest.unsupported_field',
): unknown {
  if (typeof obj !== 'object' || obj === null) return obj;
  const source = obj as Record<string, unknown>;
  const matches = Object.keys(source).filter((k) => fieldSet.has(k));
  if (matches.length === 0) return obj;
  const stripped = { ...source };
  for (const key of matches) {
    delete stripped[key];
    warnings.push({
      path: key,
      message: warningMessage(key),
      code,
    });
  }
  return stripped;
}

// ---------------------------------------------------------------------------
// Validate plugin.json
// ---------------------------------------------------------------------------

/**
 * Validate a plugin manifest file (plugin.json).
 *
 * Uses strict schema validation after removing top-level fields that runtime
 * intentionally ignores and reporting those fields as warnings.
 */
export async function validatePluginManifest(
  filePath: string,
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const absolutePath = path.resolve(filePath);

  // Read file
  let content: string;
  try {
    content = await readFile(absolutePath, { encoding: 'utf-8' });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    const message =
      code === 'ENOENT'
        ? `File not found: ${absolutePath}`
        : code === 'EISDIR'
          ? `Path is not a file: ${absolutePath}`
          : `Failed to read file: ${error}`;
    return {
      success: false,
      errors: [{ path: 'file', message, code }],
      warnings: [],
      filePath: absolutePath,
      fileType: 'plugin',
    };
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      success: false,
      errors: [{ path: 'json', message: `Invalid JSON syntax: ${error}` }],
      warnings: [],
      filePath: absolutePath,
      fileType: 'plugin',
    };
  }

  // Check path traversal in component paths before schema validation
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    checkManifestPaths(obj, errors);
  }

  // Strip fields that pass schema-level recognition but should still surface
  // a warning to the author. Each pass is non-fatal; `parsed` is replaced
  // with a copy that omits the matched keys before strict validation runs.
  let toValidate = stripFieldsWithWarnings(
    parsed,
    MARKETPLACE_ONLY_MANIFEST_FIELDS,
    (k) =>
      `Field '${k}' belongs in marketplace.json, not plugin.json. Harmless here but unused.`,
    warnings,
    'plugin.manifest.marketplace_field',
  );
  toValidate = stripFieldsWithWarnings(
    toValidate,
    RECOGNIZED_BUT_UNIMPLEMENTED_FIELDS,
    (k) =>
      `Field '${k}' is recognized but not yet implemented; it will be ignored at runtime.`,
    warnings,
    'plugin.manifest.unimplemented_field',
  );

  // Runtime Zod parsing strips unknown top-level fields. Validation reports
  // the same behavior as a warning instead of inventing a stricter validity
  // rule; callers that want warnings to block can use CLI --strict.
  if (toValidate && typeof toValidate === 'object') {
    const knownFields = new Set(Object.keys(PluginManifestSchema.shape));
    const unknownFields = new Set(
      Object.keys(toValidate as Record<string, unknown>).filter(
        (key) => !knownFields.has(key),
      ),
    );
    toValidate = stripFieldsWithWarnings(
      toValidate,
      unknownFields,
      (key) =>
        `Unknown field '${key}' will be ignored by the current runtime.`,
      warnings,
      'plugin.manifest.unknown_field',
    );
  }

  // Validate with strict schema
  const result = PluginManifestSchema.strict().safeParse(toValidate);
  if (!result.success) {
    errors.push(...formatZodErrors(result.error));
  }

  // Additional quality warnings
  if (result.success) {
    const manifest = result.data;

    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name)) {
      warnings.push({
        path: 'name',
        message: `Plugin name "${manifest.name}" is not kebab-case. Consider using lowercase with hyphens.`,
        code: 'plugin.manifest.name_not_kebab_case',
      });
    }
    if (!manifest.version) {
      warnings.push({
        path: 'version',
        message:
          'No version specified. Consider adding semver (e.g., "1.0.0").',
        code: 'plugin.manifest.version_missing',
      });
    }
    if (!manifest.description) {
      warnings.push({
        path: 'description',
        message: 'No description provided.',
        code: 'plugin.manifest.description_missing',
      });
    }
  }

  return {
    success: errors.length === 0,
    errors,
    warnings,
    filePath: absolutePath,
    fileType: 'plugin',
  };
}


/**
 * Recursively collect .md files under a directory.
 */
async function collectMarkdown(
  dir: string,
  isSkillsDir: boolean,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  // Skills use <name>/SKILL.md
  if (isSkillsDir) {
    const directSkill = entries.find(
      (entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md',
    );
    if (directSkill) return [path.join(dir, directSkill.name)];

    const nested = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => collectMarkdown(path.join(dir, entry.name), true)),
    );
    return nested.flat();
  }

  // Commands/agents: recurse and collect all .md files
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectMarkdown(full, false)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unified plugin validation report
// ---------------------------------------------------------------------------

const REPORT_SCHEMA_VERSION = 1 as const;

function toPortableRelativePath(pluginDir: string, filePath: string): string {
  const relative = path.relative(pluginDir, filePath) || '.';
  return relative.split(path.sep).join('/');
}

function toJsonPointer(logicalPath: string): string | undefined {
  if (!logicalPath || logicalPath === 'root' || logicalPath === 'file') {
    return undefined;
  }
  const parts = logicalPath
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1'));
  return parts.length > 0 ? `/${parts.join('/')}` : undefined;
}

function manifestErrorCode(error: ValidationError): string {
  if (error.code === 'plugin.path.outside_root') return error.code;
  if (error.path === 'json') return 'plugin.manifest.invalid_json';
  if (error.path === 'file') return 'plugin.manifest.unreadable';
  return 'plugin.manifest.schema_invalid';
}

function validationResultsToDiagnostics(
  results: ValidationResult[],
  pluginDir: string,
): PluginValidationDiagnostic[] {
  const diagnostics: PluginValidationDiagnostic[] = [];
  for (const result of results) {
    const relativePath = toPortableRelativePath(pluginDir, result.filePath);
    for (const error of result.errors) {
      diagnostics.push({
        severity: 'error',
        code:
          result.fileType === 'plugin'
            ? manifestErrorCode(error)
            : error.path === 'json'
              ? `plugin.${result.fileType}.invalid_json`
              : `plugin.${result.fileType}.invalid`,
        message: error.message,
        phase: result.fileType === 'plugin' ? 'manifest' : 'component',
        location: {
          path: relativePath,
          jsonPointer:
            result.fileType === 'plugin' || result.fileType === 'hooks'
              ? toJsonPointer(error.path)
              : undefined,
        },
      });
    }
    for (const warning of result.warnings) {
      diagnostics.push({
        severity: 'warning',
        code: warning.code ?? `plugin.${result.fileType}.warning`,
        message: warning.message,
        phase: result.fileType === 'plugin' ? 'manifest' : 'component',
        location: {
          path: relativePath,
          jsonPointer:
            result.fileType === 'plugin' || result.fileType === 'hooks'
              ? toJsonPointer(warning.path)
              : undefined,
        },
      });
    }
  }
  return diagnostics;
}

function loaderErrorLocation(
  error: PluginError,
  pluginDir: string,
): PluginValidationLocation | undefined {
  switch (error.type) {
    case 'manifest-parse-error':
    case 'manifest-validation-error':
      return { path: toPortableRelativePath(pluginDir, error.manifestPath) };
    case 'path-not-found':
    case 'component-load-failed':
      return { path: toPortableRelativePath(pluginDir, error.path) };
    case 'hook-load-failed':
      return { path: toPortableRelativePath(pluginDir, error.hookPath) };
    default:
      return undefined;
  }
}

function loaderErrorCode(error: PluginError): string {
  switch (error.type) {
    case 'manifest-parse-error':
    case 'manifest-validation-error':
      return 'plugin.manifest.invalid';
    case 'path-not-found':
      return 'plugin.component.path_not_found';
    case 'component-load-failed':
      return error.reason.includes('outside the plugin root')
        ? 'plugin.path.outside_root'
        : 'plugin.component.load_failed';
    case 'hook-load-failed':
      return 'plugin.hooks.invalid';
    case 'mcp-config-invalid':
      return 'plugin.mcp.invalid';
    default:
      return `plugin.load.${error.type.replaceAll('-', '_')}`;
  }
}

function loaderErrorToDiagnostic(
  error: PluginError,
  pluginDir: string,
): PluginValidationDiagnostic {
  return {
    severity: 'error',
    code: loaderErrorCode(error),
    message: getPluginErrorMessage(error),
    phase:
      error.type === 'manifest-parse-error' ||
      error.type === 'manifest-validation-error'
        ? 'manifest'
        : 'load-simulation',
    location: loaderErrorLocation(error, pluginDir),
  };
}

function dedupeDiagnostics(
  diagnostics: PluginValidationDiagnostic[],
): PluginValidationDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify([
      diagnostic.severity,
      diagnostic.code,
      diagnostic.message,
      diagnostic.location?.path,
      diagnostic.location?.jsonPointer,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function validateLoadedMarkdown(
  plugin: LoadedPlugin,
): Promise<ValidationResult[]> {
  const sources: Array<{
    fileType: 'command' | 'agent' | 'skill';
    sourcePath: string;
  }> = [];
  for (const sourcePath of [
    ...(plugin.commandsPath ? [plugin.commandsPath] : []),
    ...(plugin.commandsPaths ?? []),
    ...Object.values(plugin.commandsMetadata ?? {}).flatMap((metadata) =>
      metadata.source ? [path.resolve(plugin.path, metadata.source)] : [],
    ),
  ]) {
    sources.push({ fileType: 'command', sourcePath });
  }
  for (const sourcePath of [
    ...(plugin.agentsPath ? [plugin.agentsPath] : []),
    ...(plugin.agentsPaths ?? []),
  ]) {
    sources.push({ fileType: 'agent', sourcePath });
  }
  for (const sourcePath of [
    ...(plugin.skillsPath ? [plugin.skillsPath] : []),
    ...(plugin.skillsPaths ?? []),
  ]) {
    sources.push({ fileType: 'skill', sourcePath });
  }

  const results: ValidationResult[] = [];
  const seenFiles = new Set<string>();
  for (const source of sources) {
    let files: string[];
    try {
      const sourceStat = await stat(source.sourcePath);
      files = sourceStat.isFile()
        ? [source.sourcePath]
        : await collectMarkdown(source.sourcePath, source.fileType === 'skill');
    } catch {
      continue; // The loader already reports missing or unreadable paths.
    }

    for (const filePath of files) {
      const canonical = await realpath(filePath).catch(() =>
        path.resolve(filePath),
      );
      if (seenFiles.has(canonical)) continue;
      seenFiles.add(canonical);
      try {
        const content = await readFile(canonical, 'utf-8');
        if (!/^---\s*\n[\s\S]*?\n---/.test(content)) {
          results.push({
            success: true,
            errors: [],
            warnings: [
              {
                path: 'frontmatter',
                code: 'plugin.component.frontmatter_missing',
                message:
                  'No frontmatter block found. Add YAML frontmatter between --- delimiters.',
              },
            ],
            filePath: canonical,
            fileType: source.fileType,
          });
        }
      } catch (error) {
        results.push({
          success: false,
          errors: [
            { path: 'file', message: `Failed to read: ${String(error)}` },
          ],
          warnings: [],
          filePath,
          fileType: source.fileType,
        });
      }
    }
  }
  return results;
}

async function validateLoadedAgents(
  plugin: LoadedPlugin,
): Promise<PluginValidationDiagnostic[]> {
  const sources = [
    ...(plugin.agentsPath ? [plugin.agentsPath] : []),
    ...(plugin.agentsPaths ?? []),
  ];
  const diagnostics: PluginValidationDiagnostic[] = [];
  for (const sourcePath of new Set(sources)) {
    const result = await loadAgentsFromPath(sourcePath, {
      pluginName: plugin.name,
    });
    if (!result) continue; // Loader path diagnostics already cover this.
    for (const error of result.errors) {
      diagnostics.push({
        severity: 'error',
        code: 'plugin.agent.invalid',
        message: error.message,
        phase: 'component',
        location: {
          path: toPortableRelativePath(plugin.path, error.filePath),
        },
      });
    }
  }
  return diagnostics;
}

function countComponents(
  plugin: LoadedPlugin,
  resources: PluginResources,
): number {
  const enumerable =
    resources.skills.length +
    resources.agents.length +
    resources.mcpServers.length +
    resources.commands.length +
    resources.hooks.length;
  const structural =
    (plugin.outputStylesPath ? 1 : 0) +
    (plugin.outputStylesPaths?.length ?? 0) +
    (plugin.workflowsPath ? 1 : 0) +
    (plugin.workflowsPaths?.length ?? 0) +
    (plugin.binPath ? 1 : 0);
  return enumerable + structural;
}

async function validateLoadedPathContainment(
  plugin: LoadedPlugin,
): Promise<PluginValidationDiagnostic[]> {
  const canonicalRoot = await realpath(plugin.path).catch(() =>
    path.resolve(plugin.path),
  );
  const commandMetadataPaths = Object.values(
    plugin.commandsMetadata ?? {},
  ).flatMap((metadata) =>
    metadata.source ? [path.resolve(plugin.path, metadata.source)] : [],
  );
  const paths = [
    plugin.commandsPath,
    plugin.agentsPath,
    plugin.skillsPath,
    plugin.outputStylesPath,
    plugin.workflowsPath,
    plugin.binPath,
    ...(plugin.commandsPaths ?? []),
    ...(plugin.agentsPaths ?? []),
    ...(plugin.skillsPaths ?? []),
    ...(plugin.outputStylesPaths ?? []),
    ...(plugin.workflowsPaths ?? []),
    ...commandMetadataPaths,
  ].filter((candidate): candidate is string => Boolean(candidate));

  const diagnostics: PluginValidationDiagnostic[] = [];
  for (const candidate of new Set(paths)) {
    const canonicalPath = await realpath(candidate).catch(() => null);
    if (!canonicalPath && commandMetadataPaths.includes(candidate)) {
      diagnostics.push({
        severity: 'error',
        code: 'plugin.component.path_not_found',
        message: `Command source path not found: ${candidate}`,
        phase: 'load-simulation',
        location: { path: toPortableRelativePath(plugin.path, candidate) },
      });
      continue;
    }
    if (canonicalPath && !isPathContained(canonicalPath, canonicalRoot)) {
      diagnostics.push({
        severity: 'error',
        code: 'plugin.path.outside_root',
        message: `Path resolves outside the plugin root: ${candidate}`,
        phase: 'load-simulation',
        location: { path: toPortableRelativePath(plugin.path, candidate) },
      });
    }
  }
  return diagnostics;
}

async function reportVersion(): Promise<string> {
  return getVersion().catch(() => 'unknown');
}

async function createReport(args: {
  inputPath: string;
  resolvedPath: string;
  manifestPath?: string;
  plugin?: PluginValidationReport['plugin'];
  diagnostics: PluginValidationDiagnostic[];
  resources?: PluginResources;
  componentCount?: number;
}): Promise<PluginValidationReport> {
  const diagnostics = dedupeDiagnostics(args.diagnostics);
  const errorCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error',
  ).length;
  const warningCount = diagnostics.length - errorCount;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    validator: { name: BRAND_CLI_BIN, version: await reportVersion() },
    valid: errorCount === 0,
    target: {
      inputPath: args.inputPath,
      resolvedPath: args.resolvedPath,
      manifestPath: args.manifestPath,
    },
    plugin: args.plugin,
    diagnostics,
    summary: {
      errorCount,
      warningCount,
      componentCount: args.componentCount ?? 0,
    },
    resources: args.resources,
  };
}

/**
 * Validate one local plugin without executing hooks, MCP servers, or binaries.
 * Invalid plugin content is returned as a report; unexpected validator failures
 * are reserved for thrown exceptions at the CLI/SDK transport boundary.
 */
export async function validatePlugin(
  inputPath: string,
): Promise<PluginValidationReport> {
  const absoluteInput = path.resolve(inputPath);
  let inputStat;
  try {
    inputStat = await stat(absoluteInput);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return createReport({
      inputPath,
      resolvedPath: absoluteInput,
      diagnostics: [
        {
          severity: 'error',
          code:
            code === 'ENOENT'
              ? 'plugin.target.not_found'
              : 'plugin.target.unreadable',
          message:
            code === 'ENOENT'
              ? `Plugin path not found: ${absoluteInput}`
              : `Cannot inspect plugin path: ${String(error)}`,
          phase: 'target',
          location: { path: '.' },
        },
      ],
    });
  }

  let pluginDir: string;
  let manifestPath: string | null = null;
  if (inputStat.isDirectory()) {
    pluginDir = await realpath(absoluteInput).catch(() => absoluteInput);
    manifestPath = await findManifestPath(pluginDir);
  } else if (
    inputStat.isFile() &&
    path.basename(absoluteInput) === 'plugin.json' &&
    PLUGIN_META_DIRS.includes(
      path.basename(
        path.dirname(absoluteInput),
      ) as (typeof PLUGIN_META_DIRS)[number],
    )
  ) {
    manifestPath = await realpath(absoluteInput).catch(() => absoluteInput);
    pluginDir = path.dirname(path.dirname(manifestPath));
  } else {
    return createReport({
      inputPath,
      resolvedPath: absoluteInput,
      diagnostics: [
        {
          severity: 'error',
          code: 'plugin.target.invalid_type',
          message:
            'Expected a plugin directory or a plugin.json inside a supported metadata directory.',
          phase: 'target',
          location: { path: '.' },
        },
      ],
    });
  }

  const diagnostics: PluginValidationDiagnostic[] = [];
  const manifestRelativePath = manifestPath
    ? toPortableRelativePath(pluginDir, manifestPath)
    : undefined;

  if (manifestPath) {
    const canonicalManifest = await realpath(manifestPath).catch(() => null);
    if (canonicalManifest && !isPathContained(canonicalManifest, pluginDir)) {
      diagnostics.push({
        severity: 'error',
        code: 'plugin.path.outside_root',
        message: `Manifest resolves outside the plugin root: ${manifestPath}`,
        phase: 'target',
        location: { path: manifestRelativePath ?? '.' },
      });
      return createReport({
        inputPath,
        resolvedPath: pluginDir,
        manifestPath: manifestRelativePath,
        diagnostics,
      });
    }
    const manifestResult = await validatePluginManifest(manifestPath);
    diagnostics.push(
      ...validationResultsToDiagnostics([manifestResult], pluginDir),
    );
    if (!manifestResult.success) {
      return createReport({
        inputPath,
        resolvedPath: pluginDir,
        manifestPath: manifestRelativePath,
        diagnostics,
      });
    }
  }

  const loadResult = await loadPluginFromDirectory(
    pluginDir,
    'local',
    'local',
    {
      collectValidationWarnings: true,
    },
  );
  if (!loadResult.ok) {
    diagnostics.push(loaderErrorToDiagnostic(loadResult.error, pluginDir));
    return createReport({
      inputPath,
      resolvedPath: pluginDir,
      manifestPath: manifestRelativePath,
      diagnostics,
    });
  }

  const plugin = loadResult.plugin;
  for (const warning of plugin.warnings ?? []) {
    diagnostics.push(loaderErrorToDiagnostic(warning, pluginDir));
  }

  const containmentDiagnostics = await validateLoadedPathContainment(plugin);
  diagnostics.push(...containmentDiagnostics);
  const hasContainmentError = containmentDiagnostics.length > 0;
  if (!hasContainmentError) {
    const markdownResults = await validateLoadedMarkdown(plugin);
    diagnostics.push(
      ...validationResultsToDiagnostics(markdownResults, pluginDir),
    );
    diagnostics.push(...(await validateLoadedAgents(plugin)));
  }

  const contentError = getPluginContentValidationError(plugin, pluginDir);
  if (contentError) {
    diagnostics.push({
      severity: 'error',
      code: 'plugin.installability.no_content',
      message: contentError,
      phase: 'installability',
      location: { path: '.' },
    });
  }

  const resources = hasContainmentError
    ? undefined
    : await collectPluginResources(plugin);
  return createReport({
    inputPath,
    resolvedPath: pluginDir,
    manifestPath: manifestRelativePath,
    plugin: {
      name: plugin.name,
      version: plugin.manifest.version,
      displayName: plugin.displayName,
    },
    diagnostics,
    resources,
    componentCount: resources ? countComponents(plugin, resources) : 0,
  });
}
