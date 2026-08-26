/** Clipboard write: OSC 52 (terminal-native) + platform fallback spawn. */
import { spawn } from 'node:child_process';

/**
 * OSC 52 sequence for `text`, adapted to the surrounding multiplexer
 * (opencode writeOsc52 parity). Under tmux both the bare sequence and the
 * `\x1bPtmux;` DCS passthrough are emitted: tmux relays a bare app OSC 52
 * only with set-clipboard=on (the default external drops it) and relays
 * the passthrough only with allow-passthrough=on (default off), so each
 * form covers one opt-in (verified on tmux 3.6a). GNU screen swallows a
 * bare OSC 52 and its DCS passthrough forwards the payload verbatim
 * (verified on screen 4.00.03), so the OSC is wrapped raw in a plain DCS —
 * the tmux-only `tmux;` tag would reach the outer terminal as literal
 * text.
 */
export function osc52Sequence(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const sequence = `\x1b]52;c;${b64}\x07`;
  if (env['TMUX']) {
    return sequence + `\x1bPtmux;\x1b${sequence}\x1b\\`;
  }
  if (env['STY']) {
    return `\x1bP${sequence}\x1b\\`;
  }
  return sequence;
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
      // A fast-failing helper (e.g. xclip without a display) leaves queued
      // writes behind; without a listener the resulting EPIPE crashes the
      // CLI instead of failing this copy.
      child.stdin.on('error', () => {});
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
