/** Clipboard write: OSC 52 (terminal-native) + platform fallback spawn. */
import { spawn } from 'node:child_process';

/**
 * OSC 52 sequence for `text`, wrapped in a tmux/screen DCS passthrough when
 * running inside either multiplexer (opencode writeOsc52 parity — a bare
 * OSC 52 would be swallowed by the outer terminal there).
 */
export function osc52Sequence(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const sequence = `\x1b]52;c;${b64}\x07`;
  return env['TMUX'] || env['STY']
    ? `\x1bPtmux;\x1b${sequence}\x1b\\`
    : sequence;
}

function platformCopy(text: string): Promise<void> {
  const cmd =
    process.platform === 'darwin'
      ? 'pbcopy'
      : process.platform === 'win32'
        ? 'clip'
        : 'xclip';
  const args = process.platform === 'linux' ? ['-selection', 'clipboard'] : [];
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
      );
      child.stdin.write(text);
      child.stdin.end();
    } catch (e) {
      reject(e as Error);
    }
  });
}

/**
 * Write text to the system clipboard.
 * OSC 52 first (works inside alternate screen when the terminal honors it),
 * platform command as reliable fallback. Never throws.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  // Warp blocks OSC 52 by default and shows a scary security banner; skip it there.
  const isWarp =
    /warp/i.test(process.env['TERM_PROGRAM'] ?? '') ||
    /warp/i.test(process.env['TERMINAL_EMULATOR'] ?? '');
  if (!isWarp) {
    try {
      process.stdout.write(osc52Sequence(text));
    } catch {
      /* ignore */
    }
  }
  try {
    await platformCopy(text);
    return true;
  } catch {
    return false;
  }
}
