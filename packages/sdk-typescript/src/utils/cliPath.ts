/**
 * CLI path auto-detection and subprocess spawning utilities
 *
 * Supports multiple execution modes:
 * 1. Native binary: 'qwen' (production)
 * 2. Node.js bundle: 'node /path/to/cli.js' (production validation)
 * 3. Bun bundle: 'bun /path/to/cli.js' (alternative runtime)
 * 4. TypeScript source: 'tsx /path/to/index.ts' (development)
 *
 * Auto-detection locations for native binary:
 * 1. QWEN_CODE_CLI_PATH environment variable
 * 2. ~/.volta/bin/qwen
 * 3. ~/.npm-global/bin/qwen
 * 4. /usr/local/bin/qwen
 * 5. ~/.local/bin/qwen
 * 6. ~/node_modules/.bin/qwen
 * 7. ~/.yarn/bin/qwen
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Executable types supported by the SDK
 */
export type ExecutableType = 'native' | 'node' | 'bun' | 'tsx' | 'deno';

/**
 * Spawn information for CLI process
 */
export type SpawnInfo = {
  /** Command to execute (e.g., 'qwen', 'node', 'bun', 'tsx') */
  command: string;
  /** Arguments to pass to command */
  args: string[];
  /** Type of executable detected */
  type: ExecutableType;
  /** Original input that was resolved */
  originalInput: string;
};

export function findNativeCliPath(): string {
  const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '';

  const candidates: Array<string | undefined> = [
    // 1. Environment variable (highest priority)
    process.env['QWEN_CODE_CLI_PATH'],

    // 2. Volta bin
    path.join(homeDir, '.volta', 'bin', 'qwen'),

    // 3. Global npm installations
    path.join(homeDir, '.npm-global', 'bin', 'qwen'),

    // 4. Common Unix binary locations
    '/usr/local/bin/qwen',

    // 5. User local bin
    path.join(homeDir, '.local', 'bin', 'qwen'),

    // 6. Node modules bin in home directory
    path.join(homeDir, 'node_modules', '.bin', 'qwen'),

    // 7. Yarn global bin
    path.join(homeDir, '.yarn', 'bin', 'qwen'),
  ];

  // Find first existing candidate
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }

  // Not found - throw helpful error
  throw new Error(
    'qwen CLI not found. Please:\n' +
      '  1. Install qwen globally: npm install -g qwen\n' +
      '  2. Or provide explicit executable: query({ pathToQwenExecutable: "/path/to/qwen" })\n' +
      '  3. Or set environment variable: QWEN_CODE_CLI_PATH="/path/to/qwen"\n' +
      '\n' +
      'For development/testing, you can also use:\n' +
      '  • TypeScript source: query({ pathToQwenExecutable: "/path/to/index.ts" })\n' +
      '  • Node.js bundle: query({ pathToQwenExecutable: "/path/to/cli.js" })\n' +
      '  • Force specific runtime: query({ pathToQwenExecutable: "bun:/path/to/cli.js" })',
  );
}

function isCommandAvailable(command: string): boolean {
  try {
    // Use 'which' on Unix-like systems, 'where' on Windows
    const whichCommand = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${whichCommand} ${command}`, {
      stdio: 'ignore',
      timeout: 5000, // 5 second timeout
    });
    return true;
  } catch {
    return false;
  }
}

function validateRuntimeAvailability(runtime: string): boolean {
  // Node.js is always available since we're running in Node.js
  if (runtime === 'node') {
    return true;
  }

  // Check if the runtime command is available in PATH
  return isCommandAvailable(runtime);
}

function validateFileExtensionForRuntime(
  filePath: string,
  runtime: string,
): boolean {
  const ext = path.extname(filePath).toLowerCase();

  switch (runtime) {
    case 'node':
    case 'bun':
      return ['.js', '.mjs', '.cjs'].includes(ext);
    case 'tsx':
      return ['.ts', '.tsx'].includes(ext);
    case 'deno':
      return ['.ts', '.tsx', '.js', '.mjs'].includes(ext);
    default:
      return true; // Unknown runtime, let it pass
  }
}

/**
 * Parse executable specification into components with comprehensive validation
 *
 * Supports multiple formats:
 * - 'qwen' -> native binary (auto-detected)
 * - '/path/to/qwen' -> native binary (explicit path)
 * - '/path/to/cli.js' -> Node.js bundle (default for .js files)
 * - '/path/to/index.ts' -> TypeScript source (requires tsx)
 *
 * Advanced runtime specification (for overriding defaults):
 * - 'bun:/path/to/cli.js' -> Force Bun runtime
 * - 'node:/path/to/cli.js' -> Force Node.js runtime
 * - 'tsx:/path/to/index.ts' -> Force tsx runtime
 * - 'deno:/path/to/cli.ts' -> Force Deno runtime
 *
 * @param executableSpec - Executable specification
 * @returns Parsed executable information
 * @throws Error if specification is invalid or files don't exist
 */
export function parseExecutableSpec(executableSpec?: string): {
  runtime?: string;
  executablePath: string;
  isExplicitRuntime: boolean;
} {
  if (
    executableSpec === '' ||
    (executableSpec && executableSpec.trim() === '')
  ) {
    throw new Error('Command name cannot be empty');
  }

  if (!executableSpec) {
    return {
      executablePath: findNativeCliPath(),
      isExplicitRuntime: false,
    };
  }

  // Check for runtime prefix (e.g., 'bun:/path/to/cli.js')
  const runtimeMatch = executableSpec.match(/^([^:]+):(.+)$/);
  if (runtimeMatch) {
    const [, runtime, filePath] = runtimeMatch;
    if (!runtime || !filePath) {
      throw new Error(`Invalid runtime specification: '${executableSpec}'`);
    }

    const supportedRuntimes = ['node', 'bun', 'tsx', 'deno'];
    if (!supportedRuntimes.includes(runtime)) {
      throw new Error(
        `Unsupported runtime '${runtime}'. Supported runtimes: ${supportedRuntimes.join(', ')}`,
      );
    }

    if (!validateRuntimeAvailability(runtime)) {
      throw new Error(
        `Runtime '${runtime}' is not available on this system. Please install it first.`,
      );
    }

    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(
        `Executable file not found at '${resolvedPath}' for runtime '${runtime}'. ` +
          'Please check the file path and ensure the file exists.',
      );
    }

    if (!validateFileExtensionForRuntime(resolvedPath, runtime)) {
      const ext = path.extname(resolvedPath);
      throw new Error(
        `File extension '${ext}' is not compatible with runtime '${runtime}'. ` +
          `Expected extensions for ${runtime}: ${getExpectedExtensions(runtime).join(', ')}`,
      );
    }

    return {
      runtime,
      executablePath: resolvedPath,
      isExplicitRuntime: true,
    };
  }

  // Check if it's a command name (no path separators) or a file path
  const isCommandName =
    !executableSpec.includes('/') && !executableSpec.includes('\\');

  if (isCommandName) {
    // It's a command name like 'qwen' - validate it's a reasonable command name
    if (!executableSpec || executableSpec.trim() === '') {
      throw new Error('Command name cannot be empty');
    }

    // Basic validation for command names
    if (!/^[a-zA-Z0-9._-]+$/.test(executableSpec)) {
      throw new Error(
        `Invalid command name '${executableSpec}'. Command names should only contain letters, numbers, dots, hyphens, and underscores.`,
      );
    }

    return {
      executablePath: executableSpec,
      isExplicitRuntime: false,
    };
  }

  // It's a file path - validate and resolve
  const resolvedPath = path.resolve(executableSpec);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Executable file not found at '${resolvedPath}'. ` +
        'Please check the file path and ensure the file exists. ' +
        'You can also:\n' +
        '  • Set QWEN_CODE_CLI_PATH environment variable\n' +
        '  • Install qwen globally: npm install -g qwen\n' +
        '  • For TypeScript files, ensure tsx is installed: npm install -g tsx\n' +
        '  • Force specific runtime: bun:/path/to/cli.js or tsx:/path/to/index.ts',
    );
  }

  // Additional validation for file paths
  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(
      `Path '${resolvedPath}' exists but is not a file. Please provide a path to an executable file.`,
    );
  }

  return {
    executablePath: resolvedPath,
    isExplicitRuntime: false,
  };
}

function getExpectedExtensions(runtime: string): string[] {
  switch (runtime) {
    case 'node':
    case 'bun':
      return ['.js', '.mjs', '.cjs'];
    case 'tsx':
      return ['.ts', '.tsx'];
    case 'deno':
      return ['.ts', '.tsx', '.js', '.mjs'];
    default:
      return [];
  }
}

function detectRuntimeFromExtension(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();

  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    // Default to Node.js for JavaScript files
    return 'node';
  }

  if (['.ts', '.tsx'].includes(ext)) {
    // Check if tsx is available for TypeScript files
    if (isCommandAvailable('tsx')) {
      return 'tsx';
    }
    // If tsx is not available, suggest it in error message
    throw new Error(
      `TypeScript file '${filePath}' requires 'tsx' runtime, but it's not available. ` +
        'Please install tsx: npm install -g tsx, or use explicit runtime: tsx:/path/to/file.ts',
    );
  }

  // Native executable or unknown extension
  return undefined;
}

export function prepareSpawnInfo(executableSpec?: string): SpawnInfo {
  const parsed = parseExecutableSpec(executableSpec);
  const { runtime, executablePath, isExplicitRuntime } = parsed;

  // If runtime is explicitly specified, use it
  if (isExplicitRuntime && runtime) {
    const runtimeCommand = runtime === 'node' ? process.execPath : runtime;

    return {
      command: runtimeCommand,
      args: [executablePath],
      type: runtime as ExecutableType,
      originalInput: executableSpec || '',
    };
  }

  // If no explicit runtime, try to detect from file extension
  const detectedRuntime = detectRuntimeFromExtension(executablePath);

  if (detectedRuntime) {
    const runtimeCommand =
      detectedRuntime === 'node' ? process.execPath : detectedRuntime;

    return {
      command: runtimeCommand,
      args: [executablePath],
      type: detectedRuntime as ExecutableType,
      originalInput: executableSpec || '',
    };
  }

  // Native executable or command name - use it directly
  return {
    command: executablePath,
    args: [],
    type: 'native',
    originalInput: executableSpec || '',
  };
}
