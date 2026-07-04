/**
 * Transform Data Handler
 *
 * Transforms data files using Python/Node/Bun scripts for
 * datatable/spreadsheet/html-preview blocks.
 *
 * Runs scripts in an isolated subprocess with sensitive env vars stripped.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createScriptRuntimeEnv } from '../runtime/sandbox-env.ts';
import {
  applyFilesystemIsolation,
  type FilesystemIsolationPlan,
} from '../runtime/filesystem-isolation.ts';
import {
  isPathWithinDirectory,
  isPathWithinDirectoryForCreation,
} from '../runtime/path-security.ts';
import { resolveScriptRuntime } from '../runtime/resolve-script-runtime.ts';

export interface TransformDataArgs {
  language: 'python3' | 'node' | 'bun';
  script: string;
  inputFiles: string[];
  outputFile: string;
}

const TRANSFORM_DATA_TIMEOUT_MS = 30_000;

interface TransformNetworkIsolationPlan {
  status: FilesystemIsolationPlan['status'];
  backend: FilesystemIsolationPlan['backend'] | 'none';
  command: string;
  args: string[];
}

function formatIsolationContext(
  filesystemIsolation: FilesystemIsolationPlan,
  networkIsolation: TransformNetworkIsolationPlan,
): string {
  const commandLine = [
    filesystemIsolation.command,
    ...filesystemIsolation.args,
  ].join(' ');
  return [
    '',
    `Isolation: filesystem=${filesystemIsolation.status} (${filesystemIsolation.backend}), network=${networkIsolation.status} (${networkIsolation.backend})`,
    `Command: ${commandLine.slice(0, 1000)}`,
  ].join('\n');
}

function killSandboxProcess(child: ChildProcess): void {
  if (!child.pid) {
    child.kill('SIGKILL');
    return;
  }

  try {
    if (process.platform === 'win32') {
      child.kill('SIGKILL');
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Handle the transform_data tool call.
 *
 * 1. Validates input/output file paths are within session boundaries
 * 2. Writes script to temp file
 * 3. Spawns subprocess with env var isolation
 * 4. Returns absolute output path for use in datatable/html-preview blocks
 */
export async function handleTransformData(
  ctx: SessionToolContext,
  args: TransformDataArgs,
): Promise<ToolResult> {
  if (!ctx.sessionPath || !ctx.dataPath) {
    return errorResponse(
      'transform_data requires sessionPath and dataPath in context.',
    );
  }

  const sessionDir = ctx.sessionPath;
  const dataDir = ctx.dataPath;

  // Validate outputFile doesn't escape data/ directory
  const resolvedOutput = resolve(dataDir, args.outputFile);
  if (!isPathWithinDirectoryForCreation(resolvedOutput, dataDir)) {
    return errorResponse(
      `outputFile must be within the session data directory. Got: ${args.outputFile}`,
    );
  }

  // Resolve and validate input files.
  // Allowed directories: session dir (tool results) and skills dir (skill assets).
  const allowedInputDirs = [sessionDir];
  if (ctx.skillsPath) {
    allowedInputDirs.push(resolve(ctx.skillsPath));
  }

  const resolvedInputs: string[] = [];
  for (const inputFile of args.inputFiles) {
    // Try resolving relative to session dir first; if it's absolute, resolve() returns it as-is
    const resolvedInput = resolve(sessionDir, inputFile);
    const isAllowed = allowedInputDirs.some((dir) =>
      isPathWithinDirectory(resolvedInput, dir),
    );
    if (!isAllowed) {
      return errorResponse(
        `inputFile must be within the session or skills directory. Got: ${inputFile}`,
      );
    }
    if (!existsSync(resolvedInput)) {
      return errorResponse(`input file not found: ${inputFile}`);
    }
    resolvedInputs.push(resolvedInput);
  }

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Write script to temp file
  const ext = args.language === 'python3' ? '.py' : '.js';
  const tempScript = join(dataDir, `.craft-transform-${randomUUID()}${ext}`);
  let networkIsolation: TransformNetworkIsolationPlan | null = null;
  let filesystemIsolation: FilesystemIsolationPlan | null = null;

  try {
    writeFileSync(tempScript, args.script, { encoding: 'utf-8', flag: 'wx' });

    const runtime = resolveScriptRuntime(args.language);
    const runtimeArgs = [
      ...runtime.argsPrefix,
      tempScript,
      ...resolvedInputs,
      resolvedOutput,
    ];

    filesystemIsolation = applyFilesystemIsolation(
      runtime.command,
      runtimeArgs,
      dataDir,
      {
        includeNetworkDeny: true,
        isolateIpc: true,
      },
    );
    networkIsolation = {
      status: filesystemIsolation.status,
      backend:
        filesystemIsolation.status === 'enforced'
          ? filesystemIsolation.backend
          : 'none',
      command: filesystemIsolation.command,
      args: filesystemIsolation.args,
    };

    if (filesystemIsolation.status !== 'enforced') {
      return errorResponse(
        'transform_data requires filesystem isolation in all permission modes, but no supported isolation backend is available on this platform/runtime.',
      );
    }

    const enforcedFilesystemIsolation = filesystemIsolation;
    const enforcedNetworkIsolation = networkIsolation;

    // Strip sensitive env vars + redirect runtime cache/temp paths to session data dir
    const env = createScriptRuntimeEnv({
      language: args.language,
      dataDir,
    });

    // Spawn subprocess with manual timeout that escalates to SIGKILL.
    // We can't rely on spawn()'s built-in `timeout` option because it only sends
    // SIGTERM, which can be caught/ignored — leaving the promise hanging forever.
    const result = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
    }>((resolvePromise, reject) => {
      const child = spawn(
        enforcedFilesystemIsolation.command,
        enforcedFilesystemIsolation.args,
        {
          cwd: dataDir,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        },
      );

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const killTimer = setTimeout(() => {
        timedOut = true;
        killSandboxProcess(child);
      }, TRANSFORM_DATA_TIMEOUT_MS);

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        clearTimeout(killTimer);
        if (timedOut) {
          resolvePromise({
            stdout,
            stderr: `Script timed out after ${TRANSFORM_DATA_TIMEOUT_MS / 1000}s and was killed`,
            code,
          });
        } else {
          resolvePromise({ stdout, stderr, code });
        }
      });

      child.on('error', (err) => {
        clearTimeout(killTimer);
        reject(err);
      });
    });

    if (result.code !== 0) {
      const errorOutput =
        result.stderr || result.stdout || 'Script exited with non-zero code';
      return errorResponse(
        `Script failed (exit code ${result.code}):\n${errorOutput.slice(0, 2000)}${formatIsolationContext(enforcedFilesystemIsolation, enforcedNetworkIsolation)}`,
      );
    }

    // Verify output file was created
    if (!existsSync(resolvedOutput)) {
      return errorResponse(
        `Script completed but output file was not created: ${args.outputFile}\n\nStdout: ${result.stdout.slice(0, 500)}`,
      );
    }

    // Return the absolute path for use in preview/table block "src" fields
    const lines = [`Output written to: ${resolvedOutput}`];
    lines.push(`Runtime: ${runtime.command} (source: ${runtime.source})`);
    lines.push(
      `Network isolation: ${enforcedNetworkIsolation.status} (${enforcedNetworkIsolation.backend})`,
    );
    lines.push(
      `Filesystem isolation: ${enforcedFilesystemIsolation.status} (${enforcedFilesystemIsolation.backend})`,
    );
    lines.push('');
    lines.push(
      'Use this absolute path as the "src" value in your datatable, spreadsheet, html-preview, pdf-preview, or image-preview block.',
    );
    if (result.stdout.trim()) {
      lines.push('');
      lines.push(`Stdout:\n${result.stdout.slice(0, 500)}`);
    }

    return successResponse(lines.join('\n'));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isolationContext =
      filesystemIsolation && networkIsolation
        ? formatIsolationContext(filesystemIsolation, networkIsolation)
        : '';
    return errorResponse(`Error running script: ${msg}${isolationContext}`);
  } finally {
    // Clean up temp script
    try {
      unlinkSync(tempScript);
    } catch {
      /* ignore */
    }
  }
}
