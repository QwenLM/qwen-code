/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds rich, tool-specific SerializableConfirmationDetails for the
 * permission confirmation UI.
 *
 * Extracted from ste-bridge.ts so the bridge can focus on wiring
 * StreamingToolExecutor into the Scheduler infrastructure.
 *
 * Each tool type (shell, edit/write, MCP, web-fetch, ask-user,
 * exit-plan-mode) produces a discriminated-union variant that the
 * PermissionQueue and ToolConfirmationMessage components can render
 * with appropriate formatting (bash highlighting, file diffs, etc.).
 */

import type { AnyDeclarativeTool } from './tools.js';
import { Kind } from './tools.js';
import type { SerializableConfirmationDetails } from './confirmation-details.js';
import {
  AUTO_MODE_BREAKER_DECISION_POINT,
  type ToolPermissionReason,
} from './tool-checkers/checker-reasons.js';
import type { Question } from './ask-user-types.js';
import {
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  EDIT_TOOL_NAMES,
  EDIT_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
  VIDEO_GEN_TOOL_NAME,
  VIDEO_GEN_PARAM_MODE,
  VIDEO_GEN_PARAM_PROMPT,
  VIDEO_GEN_PARAM_MEDIA,
  VIDEO_GEN_PARAM_SIZE,
  VIDEO_GEN_PARAM_DURATION_SECONDS,
} from './tool-names.js';
import { getCommandRoots } from '../utils/shell-utils.js';
import { isCompoundCommand } from './shell-permissions/shellPermissions.js';
import { DiscoveredMCPTool } from '../mcp/tools/mcp-tool.js';
import { getAllParsedPowerShellCommands, parsePowerShellCommand } from './shell-permissions/powerShellParser.js';
import path from 'node:path';
import { displayPathForWorkspace, expandPath } from '../utils/paths.js';
import * as Diff from 'diff';
import {
  DEFAULT_DIFF_OPTIONS,
  getDiffStatFromPatch,
  adjustPatchLineNumbers,
} from './diffOptions.js';
import { applyEditToFile } from './edit.js';
import {
  readEditContext,
  openForScan,
  readCapped,
  CHUNK_SIZE,
} from '../utils/readEditContext.js';
import {
  normalizeNotebook,
  getCellSourceText,
  findCellByIdOrIndex,
} from '../utils/notebook.js';
import { parseWorkflowScript } from '../workflows/workflow-parser.js';
import { normalizeWorkflowToolArgs } from '../workflows/workflow-args.js';
import {
  createWorkflowRegistryFromConfig,
  WorkflowRegistry,
  type WorkflowRegistryConfigHost,
} from '../workflows/workflow-registry.js';
import { readWorkflowScriptFile } from '../workflows/workflow-storage.js';

// ---------------------------------------------------------------------------
// Edit / Write Diff Computation
// ---------------------------------------------------------------------------


/**
 * Eagerly computes a diff for Edit/Write tools so the confirmation dialog
 * can show the user exactly what will change before they approve.
 *
 * For Edit tools, uses a windowed file scan (readEditContext) that reads
 * only ±3 lines around the old_string match — avoids loading the entire
 * file into memory. Falls back to diffing old_string vs new_string directly
 * when the file is too large, the needle isn't found, or the file doesn't exist.
 *
 * For Write tools, reads the full file (same as CC).
 *
 * Returns null for unsupported tool types (e.g. NotebookEdit).
 */
async function computeEditConfirmationDetails(
  toolName: string,
  input: Record<string, unknown>,
  filePath: string,
  fileName: string,
): Promise<SerializableConfirmationDetails | null> {
  if (!filePath) return null;

  // Write tool: full-file read (CC also reads full file for Write)
  if (toolName === WRITE_FILE_TOOL_NAME) {
    return computeWriteDiff(input, filePath, fileName);
  }

  // Edit tool: windowed scan
  if (toolName === EDIT_TOOL_NAME) {
    return computeEditDiff(input, filePath, fileName);
  }

  // NotebookEdit tool: cell-level diff
  if (toolName === NOTEBOOK_EDIT_TOOL_NAME) {
    return computeNotebookEditDiff(input, filePath, fileName);
  }

  return null;
}

/**
 * Computes diff for Write tool. Reads the current file content (capped at
 * 10 MB) and diffs against the proposed new content.
 */
async function computeWriteDiff(
  input: Record<string, unknown>,
  filePath: string,
  fileName: string,
): Promise<SerializableConfirmationDetails> {
  const newContent = (input['content'] as string) ?? '';

  let originalContent: string | null = null;
  const handle = await openForScan(filePath);
  if (handle !== null) {
    try {
      originalContent = await readCapped(handle);
    } finally {
      await handle.close();
    }
  }

  return buildEditDetails(fileName, filePath, originalContent, newContent);
}

/**
 * Computes diff for Edit tool using a windowed file scan.
 *
 * Decision tree (aligned with CC's FileEditToolDiff.loadDiffData):
 * ① old_string >= CHUNK_SIZE (8KB) → diff old_string vs new_string directly
 * ② File doesn't exist (ENOENT)    → diff old_string vs new_string directly
 * ③ replace_all=true or old_string='' → readCapped (full file, 10MB cap)
 * ④ Normal single edit              → readEditContext (±3 lines window)
 * ⑤ Any failure                     → fallback to old_string vs new_string
 */
async function computeEditDiff(
  input: Record<string, unknown>,
  filePath: string,
  fileName: string,
): Promise<SerializableConfirmationDetails> {
  const oldString = (input['old_string'] as string) ?? '';
  const newString = (input['new_string'] as string) ?? '';
  const replaceAll = !!(input['allow_multiple'] as boolean);

  // ① Large old_string — skip file read entirely
  if (Buffer.byteLength(oldString, 'utf8') >= CHUNK_SIZE) {
    return buildEditDetails(fileName, filePath, oldString || null, newString);
  }

  // ③ replace_all or empty old_string → need full file content
  if (replaceAll || oldString === '') {
    const handle = await openForScan(filePath);
    // ② File doesn't exist
    if (handle === null) {
      return buildEditDetails(fileName, filePath, oldString || null, newString);
    }
    try {
      const fullContent = await readCapped(handle);
      if (fullContent === null) {
        // File exceeds 10MB cap
        return buildEditDetails(
          fileName,
          filePath,
          oldString || null,
          newString,
        );
      }
      const newContent = applyEditToFile(
        fullContent,
        oldString,
        newString,
        replaceAll,
      );
      return buildEditDetails(fileName, filePath, fullContent, newContent);
    } finally {
      await handle.close();
    }
  }

  // ④ Normal single edit — windowed scan
  const ctx = await readEditContext(filePath, oldString);

  // ② File doesn't exist (ENOENT)
  if (ctx === null) {
    return buildEditDetails(fileName, filePath, oldString || null, newString);
  }

  // Needle not found within scan cap
  if (ctx.truncated || ctx.content === '') {
    return buildEditDetails(fileName, filePath, oldString || null, newString);
  }

  // Apply edit within the context window
  const newWindowContent = applyEditToFile(
    ctx.content,
    oldString,
    newString,
    false,
  );

  let fileDiff = Diff.createPatch(
    fileName,
    ctx.content,
    newWindowContent,
    'Current',
    'Proposed',
    DEFAULT_DIFF_OPTIONS,
  );

  if (ctx.lineOffset > 1) {
    fileDiff = adjustPatchLineNumbers(fileDiff, ctx.lineOffset - 1);
  }

  const diffStat = getDiffStatFromPatch(fileDiff);

  return {
    type: 'edit',
    title: `Edit ${fileName}`,
    fileName,
    filePath,
    fileDiff,
    originalContent: ctx.content,
    newContent: newWindowContent,
    diffStat,
  };
}

/**
 * Computes a cell-level diff for NotebookEdit tool confirmation.
 *
 * Reads the current notebook, finds the target cell, and generates a unified
 * diff between the old cell source and the proposed new source.
 */
async function computeNotebookEditDiff(
  input: Record<string, unknown>,
  filePath: string,
  fileName: string,
): Promise<SerializableConfirmationDetails | null> {
  const newSource = (input['new_source'] as string) ?? '';
  const cellId = input['cell_id'] as string | undefined;
  const editMode = (input['edit_mode'] as string) ?? 'replace';

  const handle = await openForScan(filePath);
  if (handle === null) {
    return buildEditDetails(fileName, filePath, null, newSource);
  }

  let notebookContent: string | null;
  try {
    notebookContent = await readCapped(handle);
  } finally {
    await handle.close();
  }

  if (!notebookContent) {
    return buildEditDetails(fileName, filePath, null, newSource);
  }

  let notebook;
  try {
    notebook = normalizeNotebook(JSON.parse(notebookContent));
  } catch {
    return buildEditDetails(fileName, filePath, null, newSource);
  }

  // Look up existing cell source (shared by delete and replace)
  let originalContent: string | null = null;
  if (cellId && editMode !== 'insert') {
    const found = findCellByIdOrIndex(notebook.cells, cellId);
    if (found) {
      originalContent = getCellSourceText(found.cell);
    }
  }

  const newContent = editMode === 'delete' ? '' : newSource;
  if (editMode === 'insert') originalContent = '';

  return buildEditDetails(fileName, filePath, originalContent, newContent);
}

/** Builds edit confirmation details with diff computation. */
function buildEditDetails(
  fileName: string,
  filePath: string,
  originalContent: string | null,
  newContent: string,
): SerializableConfirmationDetails {
  const fileDiff = Diff.createPatch(
    fileName,
    originalContent ?? '',
    newContent,
    'Current',
    'Proposed',
    DEFAULT_DIFF_OPTIONS,
  );
  const diffStat = getDiffStatFromPatch(fileDiff);
  return {
    type: 'edit',
    title: `Edit ${fileName}`,
    fileName,
    filePath,
    fileDiff,
    originalContent,
    newContent,
    diffStat,
  };
}

/**
 * Narrows an untyped record value to a string.
 *
 * The lint rule bans `typeof obj['key'] === 'string'` at the property access and asks
 * for a guard instead, which is also the form the rest of the package uses.
 */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

async function buildWorkflowConfirmationDetails(
  input: Record<string, unknown>,
  message: string | undefined,
  targetDir?: string,
  workflowRegistryHost?: WorkflowRegistryConfigHost,
): Promise<SerializableConfirmationDetails> {
  const rawScript = input['script'];
  const rawName = input['name'];
  const rawScriptPath = input['scriptPath'];
  const inlineScript = isString(rawScript) ? rawScript : undefined;
  const workflowName = isString(rawName) ? rawName : undefined;
  const scriptPath = isString(rawScriptPath) ? rawScriptPath : undefined;

  // Keep confirmation metadata on the same source that Workflow.execute will
  // resolve: scriptPath > script > name. Never fall back to a lower-priority
  // source when the selected source is unreadable; execution will fail too.
  let script = scriptPath ? undefined : inlineScript;
  let resolvedScriptPath = scriptPath;
  let source: 'inline' | 'name' | 'scriptPath' | 'unknown' = scriptPath
    ? 'scriptPath'
    : inlineScript
      ? 'inline'
      : workflowName
        ? 'name'
        : 'unknown';

  try {
    if (scriptPath && targetDir) {
      const resolved = await readWorkflowScriptFile(scriptPath, targetDir);
      script = resolved.script;
      resolvedScriptPath = resolved.scriptPath;
      source = 'scriptPath';
    } else if (!script && workflowName && targetDir) {
      const registry = workflowRegistryHost
        ? createWorkflowRegistryFromConfig(workflowRegistryHost)
        : WorkflowRegistry.createDefault(targetDir);
      const resolved = await registry.resolve(workflowName);
      script = resolved.script;
      resolvedScriptPath = resolved.scriptPath;
      source = 'name';
    }
  } catch {
    // Validation will surface unreadable scripts separately. The permission UI
    // still shows the available invocation metadata.
  }

  let meta;
  if (script) {
    try {
      meta = parseWorkflowScript(script).meta;
    } catch {
      // Validation owns syntax/meta errors; keep the confirmation renderable.
    }
  }

  return {
    type: 'workflow',
    title: 'Run a dynamic workflow?',
    prompt: message,
    workflowName: meta?.name ?? workflowName,
    description: meta?.description,
    source,
    script,
    scriptPath: resolvedScriptPath,
    args: normalizeWorkflowToolArgs(input['args']),
    meta,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** What a prompt tells the details builder beyond the input and message. */
export interface ConfirmationPresentationOptions {
  /** The prompt's `persistable`; false hides the "always allow" option. */
  persistable?: boolean;
  /** The ask's attribution kind, when the check stated one. */
  safetyCheckKind?: string;
}

/**
 * The presentation options a prompt implies, for every channel that builds
 * confirmation details from an ask prompt.
 */
export function presentationOptionsForPrompt(prompt: {
  reason: ToolPermissionReason;
  persistable?: boolean;
}): ConfirmationPresentationOptions {
  const { attribution } = prompt.reason;
  return {
    ...(prompt.persistable === false ? { persistable: false } : {}),
    ...(attribution.type === 'safetyCheck' && attribution.safetyCheckKind
      ? { safetyCheckKind: attribution.safetyCheckKind }
      : {}),
  };
}

/**
 * Builds a rich SerializableConfirmationDetails object based on the tool type.
 * This allows the PermissionQueue UI to render tool-specific information
 * (bash-highlighted commands, MCP server details, file paths, etc.)
 * instead of a generic text message.
 */
export async function buildConfirmationDetails(
  tool: AnyDeclarativeTool,
  input: Record<string, unknown>,
  message: string | undefined,
  planPath?: string,
  targetDir?: string,
  workflowRegistryHost?: WorkflowRegistryConfigHost,
  options?: ConfirmationPresentationOptions,
): Promise<SerializableConfirmationDetails> {
  const toolName = tool.name;

  // Shell tool → exec type (bash-highlighted command). Only when there IS a
  // command: Execute-kind tools may carry their payload in other fields
  // (BashInput sends `chars`, not `command`), and an empty exec detail would
  // hide the ask message. Those fall through to the message-based branches.
  if (toolName === SHELL_TOOL_NAME || tool.kind === Kind.Execute) {
    const command = (input['command'] as string) ?? '';
    if (command) {
      const rawDesc = input['description'];
      const description =
        typeof rawDesc === 'string' && rawDesc.trim() ? rawDesc : undefined;
      const powerShellParse =
        toolName === POWERSHELL_TOOL_NAME
          ? await parsePowerShellCommand(command)
          : undefined;
      const powerShellCommands = powerShellParse
        ? getAllParsedPowerShellCommands(powerShellParse)
        : undefined;
      const roots = powerShellCommands
        ? powerShellCommands
            .map((entry) => entry.canonicalName ?? entry.name)
            .filter((name): name is string => !!name)
        : getCommandRoots(command, 'bash');
      const uniqueRoots = [...new Set(roots)];
      const compound =
        toolName === POWERSHELL_TOOL_NAME ? false : isCompoundCommand(command);
      const systemMessage =
        options?.safetyCheckKind && message ? message : undefined;
      return {
        type: 'exec',
        title: command,
        command,
        rootCommand:
          uniqueRoots.length > 1
            ? uniqueRoots.join(', ')
            : (uniqueRoots[0] ?? command),
        rootCommands: uniqueRoots,
        commands: [command],
        description,
        isCompound:
          (powerShellCommands ? powerShellCommands.length > 1 : compound) ||
          undefined,
        ...(systemMessage ? { systemMessage } : {}),
        ...(options?.persistable === false ? { persistable: false } : {}),
      };
    }
  }

  // MCP tool → mcp type (server/tool details + args)
  if (tool instanceof DiscoveredMCPTool) {
    return {
      type: 'mcp',
      title: `${tool.serverToolName} (${tool.serverName})`,
      serverName: tool.serverName,
      toolName: tool.serverToolName,
      toolDisplayName: tool.displayName,
      toolArgs: input,
      toolDescription: tool.description,
      toolParameterSchema: tool.parameterSchema,
    };
  }

  // Edit/Write tool → eagerly compute diff for confirmation UI
  if (EDIT_TOOL_NAMES.has(toolName)) {
    const filePath =
      (input['file_path'] as string) ??
      (input['notebook_path'] as string) ??
      '';
    const fileName = filePath ? path.basename(filePath) : toolName;

    try {
      const editDetails = await computeEditConfirmationDetails(
        toolName,
        input,
        filePath,
        fileName,
      );
      if (editDetails) {
        if (targetDir && editDetails.type === 'edit') {
          editDetails.displayPath = displayPathForWorkspace(
            filePath,
            targetDir,
          );
        }
        return editDetails;
      }
    } catch {
      // Unexpected error (e.g. diff library bug) — fall through to 'info'
    }

    return {
      type: 'info',
      title: `Edit ${fileName}`,
      prompt: message || `Allow editing ${filePath}?`,
    };
  }

  if (toolName === WORKFLOW_TOOL_NAME) {
    return buildWorkflowConfirmationDetails(
      input,
      message,
      targetDir,
      workflowRegistryHost,
    );
  }

  // Web fetch → info type with URLs
  if (toolName === WEB_FETCH_TOOL_NAME) {
    const url = (input['url'] as string) ?? '';
    let hostname = url;
    try {
      hostname = new URL(url).hostname;
    } catch {
      // Keep original url as hostname fallback
    }
    return {
      type: 'info',
      title: `Fetching ${hostname}`,
      prompt: (input['prompt'] as string) ?? message ?? '',
      urls: url ? [url] : [],
    };
  }

  if (toolName === ASK_USER_TOOL_NAME) {
    const questions = (input['questions'] as Question[]) ?? [];
    return {
      type: ASK_USER_TOOL_NAME,
      title: 'Answer Questions',
      questions,
    };
  }

  // ExitPlanMode → dedicated dialog with plan preview
  if (toolName === EXIT_PLAN_MODE_TOOL_NAME && planPath) {
    return {
      type: EXIT_PLAN_MODE_TOOL_NAME,
      title: 'Ready to start implementation?',
      planPath,
    };
  }

  // Read tool → dedicated file_read type with workspace-aware display path
  if (toolName === READ_FILE_TOOL_NAME && targetDir) {
    const filePath = (input['file_path'] as string) ?? '';
    if (filePath) {
      const resolvedPath = expandPath(filePath, targetDir);
      const displayPath = displayPathForWorkspace(resolvedPath, targetDir);
      return {
        type: 'file_read',
        title: `Read ${displayPath}`,
        filePath: resolvedPath,
        displayPath,
        prompt: message,
      };
    }
  }

  // VideoGen → dedicated cost-confirmation panel (design §5.2)
  if (toolName === VIDEO_GEN_TOOL_NAME) {
    const mode = input[VIDEO_GEN_PARAM_MODE] as
      | 'text_to_video'
      | 'first_frame_to_video'
      | 'reference_to_video';
    const media = input[VIDEO_GEN_PARAM_MEDIA] as
      | {
          first_frame?: { source?: string };
          references?: Array<{ source?: string }>;
        }
      | undefined;
    const image =
      media?.first_frame?.source ?? media?.references?.[0]?.source ?? undefined;
    return {
      type: 'video',
      title: 'Generate video',
      prompt: (input[VIDEO_GEN_PARAM_PROMPT] as string) ?? '',
      mode,
      image,
      size: (input[VIDEO_GEN_PARAM_SIZE] as string) ?? undefined,
      durationSeconds:
        (input[VIDEO_GEN_PARAM_DURATION_SECONDS] as number) ?? undefined,
    };
  }

  // Default fallback → info type
  return {
    type: 'info',
    title: message || `Allow ${tool.name}?`,
    prompt: message || `Allow ${tool.name}?`,
  };
}

/** The decision point the auto-mode circuit breaker stamps on its ask. */
export { AUTO_MODE_BREAKER_DECISION_POINT } from './tool-checkers/checker-reasons.js';

/**
 * Confirmation details for the auto-mode circuit breaker, or undefined when
 * the ask is not the breaker's. The breaker strips suggestions and replaces
 * the message, so this dedicated info dialog must surface the limit warning.
 */
export function breakerConfirmationDetails(reason: {
  message: string;
  decisionPoint?: string;
  attribution?: { type: string; reason?: unknown };
}): SerializableConfirmationDetails | undefined {
  if (reason.decisionPoint !== AUTO_MODE_BREAKER_DECISION_POINT) {
    return undefined;
  }
  const detail = reason.attribution?.reason;
  return {
    type: 'info',
    // Renders the breaker's Yes/No gate instead of the generic info options.
    kind: 'auto_mode_breaker',
    title: 'Auto mode classifier requires confirmation',
    prompt: typeof detail === 'string' && detail ? detail : reason.message,
  };
}

// ---------------------------------------------------------------------------
// Transport projection
// ---------------------------------------------------------------------------

/**
 * Budget for the serialized confirmation details carried on external
 * permission frames (the SDK `can_use_tool` control_request). Comfortably
 * below the 16 MiB JSONL frame limit so the preview fields below can never
 * push a frame over it on their own.
 */
export const DEFAULT_MAX_WIRE_CONFIRMATION_DETAILS_BYTES = 256 * 1024;

const WIRE_DIFF_PREVIEW_BYTES = 96 * 1024;
const WIRE_CONTENT_PREVIEW_BYTES = 32 * 1024;

function truncateUtf8WithMarker(
  value: string,
  maxBytes: number,
  label: string,
): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) {
    return value;
  }
  let text = buffer.subarray(0, maxBytes).toString('utf8');
  // A multi-byte code point split by the slice decodes to a replacement
  // char at the tail; drop it so the preview ends on a clean boundary.
  if (text.length > 0 && text.charCodeAt(text.length - 1) === 0xfffd) {
    text = text.slice(0, -1);
  }
  return `${text}\n... [${label} truncated for SDK transport: showing first ${maxBytes} of ${buffer.length} bytes] ...`;
}

/**
 * Bound the details payload that leaves the process on a permission frame.
 *
 * Edit details embed the target file's current body (`originalContent`, read
 * from disk), the proposed body and the full unified patch. Overwriting a
 * large generated file therefore serializes to tens of megabytes — past the
 * headless JSONL frame limit, which refuses the frame and aborts the whole
 * session. The local confirmation UI keeps the unprojected details; only the
 * wire copy is bounded.
 *
 * Details within the budget pass through untouched, so ordinary approvals
 * keep full fidelity on the wire. Over-budget edit details degrade to
 * bounded previews plus a `truncated` marker; other variants have no
 * disk-backed unbounded field and pass through as before.
 */
export function projectConfirmationDetailsForExternalUse<
  T extends SerializableConfirmationDetails | undefined,
>(
  details: T,
  maxBytes: number = DEFAULT_MAX_WIRE_CONFIRMATION_DETAILS_BYTES,
): T {
  if (!details) {
    return details;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(details);
  } catch {
    return details;
  }
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
    return details;
  }
  if (details.type !== 'edit') {
    return details;
  }
  return {
    ...details,
    fileDiff: truncateUtf8WithMarker(
      details.fileDiff,
      WIRE_DIFF_PREVIEW_BYTES,
      'fileDiff',
    ),
    originalContent:
      details.originalContent === null
        ? null
        : truncateUtf8WithMarker(
            details.originalContent,
            WIRE_CONTENT_PREVIEW_BYTES,
            'originalContent',
          ),
    newContent: truncateUtf8WithMarker(
      details.newContent,
      WIRE_CONTENT_PREVIEW_BYTES,
      'newContent',
    ),
    truncated: true,
  } as T;
}
