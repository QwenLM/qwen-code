import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    // Support both `--key value` and the GNU/POSIX `--key=value` form.
    const eqIndex = token.indexOf('=');
    if (eqIndex !== -1) {
      args[token.slice(2, eqIndex)] = token.slice(eqIndex + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

export async function readJson(path, fallback = undefined) {
  if (!path) {
    return fallback;
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (fallback !== undefined) {
      // ENOENT is an expected "no data yet" case; anything else (corrupt
      // JSON, permission error) is degrading silently, so surface it.
      if (error.code !== 'ENOENT') {
        console.warn(`readJson: falling back for ${path}: ${error.message}`);
      }
      return fallback;
    }
    throw error;
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

// Default subprocess timeout. Without this, a hanging child (notably the
// `npx -y @qwen-code/qwen-code@latest` LLM fallback) blocks until the
// 30-minute job timeout with no diagnostic. Callers can override via
// options.timeout.
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;

export async function run(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 20 * 1024 * 1024,
    timeout: DEFAULT_RUN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    ...options,
  });
  return stdout;
}

export function requireArg(args, name) {
  if (!args[name]) {
    throw new Error(`Missing required argument --${name}`);
  }
  return args[name];
}
