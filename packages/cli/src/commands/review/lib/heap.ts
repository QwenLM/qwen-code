/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** V8's heap-limit flag, in the spellings V8 accepts. */
export const MAX_OLD_SPACE_FLAG = '--max[-_]old[-_]space[-_]size';

/**
 * The flag as one token of an options string, with its value: `=6144`, or
 * the next word.
 */
const HEAP_TOKEN_RE = new RegExp(
  `(?:^|\\s)${MAX_OLD_SPACE_FLAG}(?:=(\\d*)|\\s+(\\d+))?(?=\\s|$)`,
  'g',
);

/**
 * The heap (MB) an options string sets, or undefined when it sets none. With
 * several, the last: it is the one V8 applies.
 */
export function heapFlagMb(options: string): number | undefined {
  let mb: number | undefined;
  for (const m of options.matchAll(HEAP_TOKEN_RE)) {
    const value = m[1] || m[2];
    if (value) mb = Number(value);
  }
  return mb;
}

/** An options string with every heap flag (and its value) taken out. */
export function withoutHeapFlag(options: string): string {
  return options.replace(HEAP_TOKEN_RE, '').trim();
}

/**
 * `options` with its heap raised to `mb` — every other option kept as written
 * — or undefined when it already sets at least that much.
 */
export function raiseHeap(options: string, mb: number): string | undefined {
  if ((heapFlagMb(options) ?? 0) >= mb) return undefined;
  return `${withoutHeapFlag(options)} --max-old-space-size=${mb}`.trim();
}

/** npm's `${VAR}`, with the backslashes that escape it (`@npmcli/config`). */
const NPM_ENV_REF_RE = /(?<!\\)(\\*)\$\{([^${}]+)\}/g;

/**
 * `raiseHeap` for npm's own `node-options`, as the value to hand back through
 * `npm_config_node_options`. npm expands a `${VAR}` in what it reads there,
 * and `options` is already expanded (`npmNodeOptions`), so each one is
 * escaped the way npm unescapes it: the script gets the value as npm
 * computed it, not a second expansion of it.
 */
export function raiseNpmHeap(options: string, mb: number): string | undefined {
  return raiseHeap(options, mb)?.replace(
    NPM_ENV_REF_RE,
    (_, esc: string, name: string) => `${esc}${esc}\\\${${name}}`,
  );
}

/**
 * The line V8 prints when a Node process dies of heap exhaustion — `FATAL
 * ERROR: Reached heap limit Allocation failed - JavaScript heap out of
 * memory` and its variants. Anchored at the start of a line, where V8 prints
 * it: a test runner that echoes the text — an assertion diff (`+ FATAL …`),
 * `expected '…FATAL ERROR…'`, a code frame (`  12|   'FATAL ERROR…`) — puts
 * something before it, and is not taken for a process that died of it.
 * Measured on vitest 3: a worker that dies of heap exits the run with status
 * 1 and the banner at a line start, so the exit status cannot tell the two
 * apart.
 */
const HEAP_BANNER_RE = /^FATAL ERROR: [^\n]*JavaScript heap out of memory/m;

/** Whether a command's raw output carries V8's heap-exhaustion banner. */
export function heapBannerIn(raw: string): boolean {
  return HEAP_BANNER_RE.test(raw);
}

/**
 * Whether a failed command died of heap exhaustion. Read from
 * `heapExhausted`, which `run()` measures off the UNTRIMMED output — the
 * trimmed `output` can lose the banner to its middle cut when more than its
 * kept tail follows it. Absent means no measurement (an injected result), and
 * the trimmed output is read instead.
 */
export function ranOutOfHeap(r: {
  exitCode: number | null;
  output: string;
  heapExhausted?: boolean;
}): boolean {
  return r.exitCode !== 0 && (r.heapExhausted ?? heapBannerIn(r.output));
}

/**
 * Whether a command was SIGKILLed by something other than its deadline:
 * exit 137 (128 + 9, which npm passes through from the script it ran), or
 * killed by SIGKILL itself when the shell around it was the process killed.
 * Most often the kernel's OOM killer or a container's memory cap — the death
 * that prints no heap banner.
 *
 * Not a bare null status: that is also a command that could not start
 * (`spawnError` ENOENT/EACCES), a crash (SIGSEGV), and the boxed spawn's own
 * SIGKILL when the output overran its buffer (`spawnError` ENOBUFS).
 */
export function killedFromOutside(r: {
  exitCode: number | null;
  timedOut: boolean;
  signal?: string;
  spawnError?: string;
}): boolean {
  return (
    !r.timedOut &&
    r.spawnError === undefined &&
    (r.exitCode === 137 || (r.exitCode === null && r.signal === 'SIGKILL'))
  );
}
