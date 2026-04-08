import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Returns the global Qwen home directory (config, credentials, etc.).
 *
 * Priority: QWEN_HOME env var > ~/.qwen
 *
 * This mirrors packages/core Storage.getGlobalQwenDir() without importing
 * from core to avoid cross-package dependencies.
 */
export function getGlobalQwenDir(): string {
  const envDir = process.env['QWEN_HOME'];
  if (envDir) {
    return path.isAbsolute(envDir) ? envDir : path.resolve(envDir);
  }
  return path.join(os.homedir(), '.qwen');
}
