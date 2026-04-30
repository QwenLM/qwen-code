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
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createScriptRuntimeEnv } from '../runtime/sandbox-env.ts';
import { isPathWithinDirectory, isPathWithinDirectoryForCreation } from '../runtime/path-security.ts';
import { resolveScriptRuntime } from '../runtime/resolve-script-runtime.ts';

export interface TransformDataArgs {
  language: 'python3' | 'node' | 'bun';
  script: string;
  inputFiles: string[];
  outputFile: string;
}

const TRANSFORM_DATA_TIMEOUT_MS = 30_000;

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
  args: TransformDataArgs
): Promise<ToolResult> {
  if (!ctx.sessionPath || !ctx.dataPath) {
    return errorResponse('transform_data requires sessionPath and dataPath in context.');
  }

  const sessionDir = ctx.sessionPath;
  const dataDir = ctx.dataPath;

  // Validate outputFile doesn't escape data/ directory
  const resolvedOutput = resolve(dataDir, args.outputFile);
  if (!isPathWithinDirectoryForCreation(resolvedOutput, dataDir)) {
    return errorResponse(
      `outputFile must be within the session data directory. Got: ${args.outputFile}`
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
    const isAllowed = allowedInputDirs.some(dir => isPathWithinDirectory(resolvedInput, dir));
    if (!isAllowed) {
      return errorResponse(
        `inputFile must be within the session or skills directory. Got: ${inputFile}`
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
  const tempScript = join(tmpdir(), `craft-transform-${ctx.sessionId}-${Date.now()}${ext}`);
  writeFileSync(tempScript, args.script, 'utf-8');

  try {
    // Build command from shared runtime resolver
    const runtime = resolveScriptRuntime(args.language);
    const cmd = runtime.command;
    const spawnArgs = [...runtime.argsPrefix, tempScript, ...resolvedInputs, resolvedOutput];

    // Strip sensitive env vars + redirect runtime cache/temp paths to session data dir
    const env = createScriptRuntimeEnv({
      language: args.language,
      dataDir,
    });

    // Spawn subprocess with manual timeout that escalates to SIGKILL.
    // We can't rely on spawn()'s built-in `timeout` option because it only sends
    // SIGTERM, which can be caught/ignored — leaving the promise hanging forever.
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolvePromise, reject) => {
      const child = spawn(cmd, spawnArgs, {
        cwd: dataDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, TRANSFORM_DATA_TIMEOUT_MS);

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      child.on('close', (code) => {
        clearTimeout(killTimer);
        if (timedOut) {
          resolvePromise({ stdout, stderr: `Script timed out after ${TRANSFORM_DATA_TIMEOUT_MS / 1000}s and was killed`, code });
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
      const errorOutput = result.stderr || result.stdout || 'Script exited with non-zero code';
      return errorResponse(
        `Script failed (exit code ${result.code}):\n${errorOutput.slice(0, 2000)}`
      );
    }

    // Verify output file was created
    if (!existsSync(resolvedOutput)) {
      return errorResponse(
        `Script completed but output file was not created: ${args.outputFile}\n\nStdout: ${result.stdout.slice(0, 500)}`
      );
    }

    // Return the absolute path for use in preview/table block "src" fields
    const lines = [`Output written to: ${resolvedOutput}`];
    lines.push(`Runtime: ${cmd} (source: ${runtime.source})`);
    lines.push(`\nUse this absolute path as the "src" value in your datatable, spreadsheet, html-preview, pdf-preview, or image-preview block.`);
    if (result.stdout.trim()) {
      lines.push(`\nStdout:\n${result.stdout.slice(0, 500)}`);
    }

    return successResponse(lines.join(''));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResponse(`Error running script: ${msg}`);
  } finally {
    // Clean up temp script
    try { unlinkSync(tempScript); } catch { /* ignore */ }
  }
}
