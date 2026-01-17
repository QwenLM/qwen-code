/**
 * Open Project Service.
 *
 * Provides cross-platform functionality to open a project directory in:
 * - VS Code (or compatible editors)
 * - System terminal
 *
 * Security:
 * - Uses validateRootPath() for path validation (allowed directories check)
 * - Uses spawn() with args array (shell: false) to prevent command injection
 *
 * Platform Support:
 * - macOS: Terminal.app, VS Code via 'code' or 'open -b'
 * - Windows: Windows Terminal, PowerShell, VS Code
 * - Linux: gnome-terminal, konsole, xfce4-terminal, xterm
 */
import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { OpenProjectResponse, OpenProjectTarget } from 'chrome-mcp-shared';
import { validateRootPath } from './project-service';

// ============================================================
// Types
// ============================================================

type LaunchResult = { success: true } | { success: false; error: string };

interface LaunchAttempt {
  /** Human-readable label for error messages */
  label: string;
  /** Command to execute */
  cmd: string;
  /** Arguments array (no shell interpolation) */
  args: string[];
  /**
   * Time to wait before considering launch successful.
   * Terminal processes are long-lived, so we don't wait for exit.
   */
  successAfterMs?: number;
  /** Whether to detach the process (default: true) */
  detached?: boolean;
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Convert spawn error to human-readable string.
 */
function formatSpawnError(err: unknown): string {
  if (err instanceof Error) {
    const errnoErr = err as NodeJS.ErrnoException;
    if (errnoErr.code) {
      return `${errnoErr.code}: ${err.message}`;
    }
    return err.message;
  }
  return String(err);
}

/**
 * Format process exit information.
 */
function formatExitFailure(code: number | null, signal: NodeJS.Signals | null): string {
  if (typeof code === 'number') {
    return `Exit code ${code}`;
  }
  if (signal) {
    return `Terminated by signal ${signal}`;
  }
  return 'Exited with unknown status';
}

// ============================================================
// Launch Logic
// ============================================================

/**
 * Attempt to launch a process.
 *
 * Strategy:
 * - If spawn fails immediately (e.g., ENOENT): return failure
 * - If process exits quickly with code 0: return success
 * - If process exits quickly with non-zero: return failure
 * - If process is still running after successAfterMs: return success
 *   (for long-lived terminal processes)
 */
async function tryLaunch(attempt: LaunchAttempt): Promise<LaunchResult> {
  const successAfterMs = attempt.successAfterMs ?? 1500;
  const detached = attempt.detached !== false;

  return new Promise<LaunchResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
    };

    const child = spawn(attempt.cmd, attempt.args, {
      shell: false,
      stdio: 'ignore',
      detached,
    });

    if (detached) {
      // Let the child process continue independently
      child.unref();
    }

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ success: false, error: formatSpawnError(err) });
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: formatExitFailure(code, signal) });
      }
    });

    // If process is still running after timeout, consider it successful
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ success: true });
    }, successAfterMs);
  });
}

/**
 * Try multiple launch attempts in sequence until one succeeds.
 */
async function runFallbackSequence(errorTitle: string, attempts: LaunchAttempt[]): Promise<void> {
  const errors: string[] = [];

  for (const attempt of attempts) {
    const result = await tryLaunch(attempt);
    if (result.success) {
      return;
    }
    errors.push(`${attempt.label}: ${result.error}`);
  }

  throw new Error(`${errorTitle}\n${errors.map((e) => `  - ${e}`).join('\n')}`);
}

// ============================================================
// VS Code
// ============================================================

/**
 * Open directory in VS Code.
 *
 * Strategy:
 * - All platforms: try 'code' command first
 * - Windows: also try 'code.cmd'
 * - macOS: fallback to 'open -b com.microsoft.VSCode'
 */
async function openInVSCode(absolutePath: string): Promise<void> {
  const platform = os.platform();

  const attempts: LaunchAttempt[] = [
    {
      label: 'code',
      cmd: 'code',
      args: [absolutePath],
      successAfterMs: 8000, // VS Code takes time to start
    },
  ];

  // Windows: code.cmd is the batch wrapper
  if (platform === 'win32') {
    attempts.push({
      label: 'code.cmd',
      cmd: 'code.cmd',
      args: [absolutePath],
      successAfterMs: 8000,
    });
  }

  // macOS: fallback to bundle identifier
  if (platform === 'darwin') {
    attempts.push({
      label: 'open -b com.microsoft.VSCode',
      cmd: 'open',
      args: ['-b', 'com.microsoft.VSCode', absolutePath],
      successAfterMs: 3000,
    });
  }

  await runFallbackSequence(`Failed to open VS Code for: ${absolutePath}`, attempts);
}

/**
 * Open a file in VS Code at a specific line/column.
 *
 * Uses 'code -g file:line:col' syntax for goto functionality.
 * Also opens the project root with -r to reuse existing window.
 *
 * Security:
 * - Validates that file path stays within project root
 * - Uses spawn with args array (no shell interpolation)
 *
 * @param projectRoot - Project root directory (for security validation and -r flag)
 * @param filePath - File path (relative or absolute)
 * @param line - Optional line number (1-based)
 * @param column - Optional column number (1-based)
 */
export async function openFileInVSCode(
  projectRoot: string,
  filePath: string,
  line?: number,
  column?: number,
): Promise<OpenProjectResponse> {
  try {
    // Validate project root
    const projectValidation = await validateRootPath(projectRoot);
    if (!projectValidation.valid) {
      return {
        success: false,
        error: projectValidation.error ?? 'Invalid project rootPath',
      };
    }
    if (!projectValidation.exists) {
      return {
        success: false,
        error: `Project directory does not exist: ${projectValidation.absolute}`,
      };
    }

    const rootAbs = projectValidation.absolute;

    // Validate file path
    const trimmedFile = String(filePath ?? '').trim();
    if (!trimmedFile) {
      return { success: false, error: 'filePath is required' };
    }

    // Resolve file path with smart fallback
    // Some frameworks (Vue/Vite) return paths like "/src/components/Foo.vue" which
    // look absolute but are actually relative to project root. We try multiple strategies:
    // 1. If path looks absolute and exists as-is, use it
    // 2. Otherwise, strip leading slash and try as relative path
    // 3. Finally, try as relative path directly
    let absoluteFile: string = '';
    let fileExists = false;

    if (path.isAbsolute(trimmedFile)) {
      // Try as true absolute path first
      const asAbsolute = path.resolve(trimmedFile);
      try {
        const fileStat = await stat(asAbsolute);
        if (fileStat.isFile()) {
          absoluteFile = asAbsolute;
          fileExists = true;
        }
      } catch {
        // Not found as absolute path
      }

      // If not found and path starts with /, try stripping it and treating as relative
      if (!fileExists && trimmedFile.startsWith('/')) {
        const strippedPath = trimmedFile.slice(1);
        const asRelative = path.resolve(rootAbs, strippedPath);
        try {
          const fileStat = await stat(asRelative);
          if (fileStat.isFile()) {
            absoluteFile = asRelative;
            fileExists = true;
          }
        } catch {
          // Not found as relative path either
        }
      }

      // Default to absolute interpretation if nothing found
      if (!absoluteFile) {
        absoluteFile = path.resolve(trimmedFile);
      }
    } else {
      // Relative path - resolve against project root
      absoluteFile = path.resolve(rootAbs, trimmedFile);
    }

    // Security: ensure file stays within project root
    const relativeToRoot = path.relative(rootAbs, absoluteFile);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      return { success: false, error: 'File path must be within project directory' };
    }

    // Check file exists
    if (!fileExists) {
      try {
        const fileStat = await stat(absoluteFile);
        if (!fileStat.isFile()) {
          return { success: false, error: `Not a file: ${absoluteFile}` };
        }
      } catch {
        return { success: false, error: `File does not exist: ${absoluteFile}` };
      }
    }

    // Validate and sanitize line/column
    const safeLine =
      typeof line === 'number' && Number.isFinite(line) && line > 0 ? Math.floor(line) : undefined;
    const safeColumn =
      typeof column === 'number' && Number.isFinite(column) && column > 0
        ? Math.floor(column)
        : undefined;

    // Build goto argument: file:line:col
    let gotoArg = absoluteFile;
    if (safeLine) {
      gotoArg += `:${safeLine}`;
      if (safeColumn) {
        gotoArg += `:${safeColumn}`;
      }
    }

    const platform = os.platform();

    // Build launch attempts
    // Use -r to reuse existing window, -g for goto
    const attempts: LaunchAttempt[] = [
      {
        label: 'code -r -g',
        cmd: 'code',
        args: ['-r', rootAbs, '-g', gotoArg],
        successAfterMs: 8000,
      },
    ];

    if (platform === 'win32') {
      attempts.push({
        label: 'code.cmd -r -g',
        cmd: 'code.cmd',
        args: ['-r', rootAbs, '-g', gotoArg],
        successAfterMs: 8000,
      });
    }

    if (platform === 'darwin') {
      // macOS: use --args to pass flags to VS Code
      attempts.push({
        label: 'open -b com.microsoft.VSCode --args',
        cmd: 'open',
        args: ['-b', 'com.microsoft.VSCode', '--args', '-r', rootAbs, '-g', gotoArg],
        successAfterMs: 3000,
      });
    }

    await runFallbackSequence(`Failed to open VS Code for: ${gotoArg}`, attempts);
    return { success: true };
  } catch (error) {
    return { success: false, error: formatSpawnError(error) };
  }
}

// ============================================================
// Terminal
// ============================================================

/**
 * Open directory in system terminal.
 */
async function openInTerminal(absolutePath: string): Promise<void> {
  const platform = os.platform();

  switch (platform) {
    case 'darwin':
      return openTerminalDarwin(absolutePath);
    case 'win32':
      return openTerminalWindows(absolutePath);
    case 'linux':
      return openTerminalLinux(absolutePath);
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

/**
 * macOS: Open Terminal.app with directory.
 */
async function openTerminalDarwin(absolutePath: string): Promise<void> {
  await runFallbackSequence(`Failed to open Terminal for: ${absolutePath}`, [
    {
      label: 'open -a Terminal',
      cmd: 'open',
      args: ['-a', 'Terminal', absolutePath],
      successAfterMs: 3000,
    },
  ]);
}

/**
 * Windows: Open Windows Terminal or PowerShell.
 */
async function openTerminalWindows(absolutePath: string): Promise<void> {
  await runFallbackSequence(`Failed to open terminal for: ${absolutePath}`, [
    // Windows Terminal (wt)
    {
      label: 'wt -d',
      cmd: 'wt',
      args: ['-d', absolutePath],
      successAfterMs: 3000,
    },
    // PowerShell fallback - using -LiteralPath to handle special characters
    // Use powershell.exe for better PATH compatibility
    {
      label: 'powershell.exe Set-Location',
      cmd: 'powershell.exe',
      args: ['-NoExit', '-Command', 'Set-Location -LiteralPath $args[0]', absolutePath],
      successAfterMs: 1500,
    },
  ]);
}

/**
 * Linux: Try common terminal emulators in sequence.
 */
async function openTerminalLinux(absolutePath: string): Promise<void> {
  await runFallbackSequence(
    `Failed to open terminal for: ${absolutePath}. Please install gnome-terminal, konsole, xfce4-terminal, or xterm.`,
    [
      // GNOME Terminal
      {
        label: 'gnome-terminal',
        cmd: 'gnome-terminal',
        args: ['--working-directory', absolutePath],
        successAfterMs: 3000,
      },
      // KDE Konsole
      {
        label: 'konsole',
        cmd: 'konsole',
        args: ['--workdir', absolutePath],
        successAfterMs: 3000,
      },
      // XFCE Terminal
      {
        label: 'xfce4-terminal',
        cmd: 'xfce4-terminal',
        args: ['--working-directory', absolutePath],
        successAfterMs: 3000,
      },
      // xterm (last resort)
      {
        label: 'xterm',
        cmd: 'xterm',
        // Use bash with positional parameter to safely pass the path
        args: ['-e', 'bash', '-lc', 'cd -- "$1" && exec "${SHELL:-bash}"', '_', absolutePath],
        successAfterMs: 3000,
      },
    ],
  );
}

// ============================================================
// Public API
// ============================================================

/**
 * Open a project directory in the specified target application.
 *
 * @param rootPath - The project directory path
 * @param target - 'vscode' or 'terminal'
 * @returns Response indicating success or failure with error message
 */
export async function openProjectDirectory(
  rootPath: string,
  target: OpenProjectTarget,
): Promise<OpenProjectResponse> {
  try {
    // Validate path security and existence
    const validation = await validateRootPath(rootPath);

    if (!validation.valid) {
      return {
        success: false,
        error: validation.error ?? 'Invalid project rootPath',
      };
    }

    if (!validation.exists) {
      return {
        success: false,
        error: `Directory does not exist: ${validation.absolute}`,
      };
    }

    const absolutePath = validation.absolute;

    // Open in target application
    switch (target) {
      case 'vscode':
        await openInVSCode(absolutePath);
        return { success: true };

      case 'terminal':
        await openInTerminal(absolutePath);
        return { success: true };

      default: {
        // Type guard for exhaustive check
        const _exhaustive: never = target;
        return {
          success: false,
          error: `Unsupported target: ${String(_exhaustive)}`,
        };
      }
    }
  } catch (error) {
    return {
      success: false,
      error: formatSpawnError(error),
    };
  }
}
