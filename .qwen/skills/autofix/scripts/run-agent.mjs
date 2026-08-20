#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const skillPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'SKILL.md',
);
const QWEN_TIMEOUT_MS = Number(process.env.QWEN_TIMEOUT_MS) || 50 * 60 * 1000;
// Idle watchdog: a wedged sandbox produces NOTHING — four observed hangs
// (#8663 x2, #8761 r3, #8763 r4) each printed their last byte at docker
// container entry and then sat silent for the whole absolute budget,
// burning 2 hours per round for zero work. Streamed agent events keep active
// runs observable; the longest silence the fleet tolerates elsewhere is the
// review pipeline's 10-minute stream-idle window for thinking phases on
// ~1M-token contexts, so twice that is the default. Distinct from
// QWEN_TIMEOUT_MS so
// the failure comment says which limit fired; a leg whose absolute budget is
// shorter than this window (the review workflow's 18-minute repair pass)
// always reaches the absolute timer first.
const parsedIdleTimeoutMs = Number(process.env.QWEN_IDLE_TIMEOUT_MS);
// Reject negative/0/NaN: Number('-1') is truthy, so a bare `|| default`
// guard would arm a sub-second window and kill every agent at the first
// idle tick.
const QWEN_IDLE_TIMEOUT_MS =
  Number.isFinite(parsedIdleTimeoutMs) && parsedIdleTimeoutMs > 0
    ? parsedIdleTimeoutMs
    : 20 * 60 * 1000;
const MAX_STREAM_JSON_LINE_LENGTH = 1024 * 1024;
const OVERSIZED_STREAM_JSON_LINE_NOTICE =
  '[run-agent] dropped oversized stream-json line; full bytes in agent.log\n';
const specs = {
  'assess-candidates': {
    inputs: ['candidates.json'],
    outputs: ['decision.json'],
    invocation: (o) => `/autofix assess-candidates --workdir ${o.workdir}`,
  },
  'develop-issue': {
    inputs: ['candidates.json', 'decision.json'],
    outputs: ['e2e-report.md', 'pr-title.txt', 'pr-body.md'],
    required: ['issue'],
    invocation: (o) =>
      `/autofix develop-issue --issue ${o.issue} --workdir ${o.workdir}`,
  },
  'address-review': {
    inputs: ['feedback.md'],
    outputs: ['address-summary.md', 'no-action.md'],
    required: ['pr', 'issue'],
    anyOutput: true,
    exclusiveOutput: true,
    invocation: (o) =>
      `/autofix address-review --pr ${o.pr} --issue ${o.issue} --workdir ${o.workdir} --conflict ${o.conflict} --base ${o.base}`,
  },
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function file(workdir, name) {
  return resolve(workdir, name);
}

function missing(workdir, names) {
  return names.filter((name) => {
    const path = file(workdir, name);
    return !existsSync(path) || statSync(path).size === 0;
  });
}

function writeFailure(workdir, message) {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(
    file(workdir, 'failure.md'),
    `${message}\n\nSee the Qwen Autofix agent step logs for model/tool output.\n`,
  );
}

// Classify a model-side [API Error] render as recoverable, and by CAUSE:
//   'transient' - 429 / 5xx / rate-limit / overload / quota: self-heals on its
//                 own once the limit resets, so it earns the full retry budget.
//   'auth'      - 401 / 402 / 403, or a render saying the model does not exist
//                 or the key has no access: ONLY a maintainer can fix it, so
//                 the workflow caps these retries low and then goes terminal
//                 with the operator fix (each attempt costs an agent run AND a
//                 PR comment; a hundred of them help nobody).
//   ''          - terminal: reproduces identically forever (a malformed 400).
//
// The status code is read from its POSITION in the render (`[API Error: <code>`)
// rather than matched anywhere in the text. Matching anywhere made permanent
// failures look retryable: `400 Invalid value for max_tokens: must be <= 512`
// matched a bare \b5\d\d\b, and `400 context length exceeded` matched a bare
// `exceeded` - both reproduce forever. `exceeded` therefore only counts as part
// of `quota`. The match is single-line ([^\]\n]) so a multi-line render cannot
// smuggle a newline into the marker or the PR-comment headline.
const TRANSIENT_API_ERROR =
  /rate.?limit|quota|RESOURCE_EXHAUSTED|overloaded|temporarily|too many requests|速率限制|配额|服务(?:繁忙|不可用)/i;
// Transport-level failures carry no HTTP status at all - the request never got
// far enough to have one. They are unambiguously retryable, and leaving them
// out stranded #7365 at round 2/100 on a bare
// `[API Error: terminated (cause: read ECONNRESET)]`. ENOTFOUND is deliberately
// excluded: a hostname that does not resolve is a misconfigured endpoint, which
// repeats forever like a bad model name.
const TRANSPORT_API_ERROR =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|fetch failed|terminated/i;
// "does not exist or you do not have access to it" is the OpenAI-compatible
// render of the same condition a 403 reports - same root cause, same fix.
const AUTH_API_ERROR =
  /api key|do not have access|does not exist|unauthorized|forbidden/i;

function classifyApiError(render) {
  const code = render.match(/\[API Error:\s*(\d{3})\b/)?.[1];
  if (code) {
    const status = Number(code);
    if (status === 429 || (status >= 500 && status <= 599)) return 'transient';
    if (status === 401 || status === 402 || status === 403) return 'auth';
    // 400 is always a malformed client request — it never self-heals by retry,
    // regardless of what the message says. Route it terminal unconditionally
    // so a 'does not exist' in the body (a tool name, a field name) cannot
    // trigger the auth/access retry path.
    if (status === 400) return '';
    // Any other code (404, ...) is permanent UNLESS the message itself names
    // an access/existence problem.
    return AUTH_API_ERROR.test(render) ? 'auth' : '';
  }
  // Code-less render: fall back to the keyword arms.
  if (AUTH_API_ERROR.test(render)) return 'auth';
  if (TRANSPORT_API_ERROR.test(render)) return 'transient';
  return TRANSIENT_API_ERROR.test(render) ? 'transient' : '';
}

// Returns { error, kind }; error is '' when nothing recoverable was found.
// NOTE: the caller passes the last 20 KB of output, so an API error emitted
// early in a long run can scroll out and be classified terminal. That is the
// fail-safe direction (a missed retry, never a wrongly-retried permanent
// failure), but detection is best-effort rather than guaranteed.
function recoverableApiError(output) {
  const wrapped = output.match(/\[API Error:[^\]\n]*\]/g) || [];
  if (wrapped.length > 0) {
    // Classify only the LAST render — it represents the terminal state of the
    // run. An earlier transient error followed by a permanent one must not
    // retry: the permanent error reproduces identically on every attempt.
    const last = wrapped[wrapped.length - 1];
    const kind = classifyApiError(last);
    if (kind) return { error: last, kind };
    // Terminal wrapped error — do NOT fall through to the OAuth fallback.
    // The standalone quota form only appears when there is NO [API Error:]
    // wrapper at all; matching it here would override a terminal verdict.
    return { error: '', kind: '' };
  }
  // Some quota errors are never wrapped in [API Error: ...] (e.g. Qwen OAuth
  // quota returns early before formatting) - catch the known standalone form.
  const oauth = output.match(/Qwen OAuth quota exceeded[^\n]*/i);
  if (oauth) return { error: `[API Error: ${oauth[0]}]`, kind: 'transient' };
  return { error: '', kind: '' };
}

function writeHandoff(workdir, message) {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(file(workdir, 'handoff.md'), `${message}\n`);
}

function isLoopGuardOutput(output) {
  return (
    output.includes('turn_tool_call_cap') ||
    output.includes('Loop detection halted the run')
  );
}

function streamResultOutput(event) {
  if (!event || event.type !== 'result') return '';
  return [event.error?.message, event.result]
    .filter((value) => typeof value === 'string')
    .join('\n');
}

function isLoopGuardResult(event) {
  return (
    event?.is_error === true && isLoopGuardOutput(streamResultOutput(event))
  );
}

function killQwen(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function runQwen(options, prompt) {
  mkdirSync(options.workdir, { recursive: true });
  const log = createWriteStream(file(options.workdir, 'agent.log'), {
    flags: 'w',
  });
  log.on('error', () => {});
  let diagnosticTail = '';
  let stdoutCarry = '';
  let discardingOversizedStdoutLine = false;
  let terminalResult;
  let settled = false;
  let timedOut = false;
  let idleTimedOut = false;
  let lastOutputAt = Date.now();
  // The sandbox launcher prints the container name before the container
  // starts (packages/cli/src/utils/sandbox.ts), so the FIRST match is this
  // run's own container — the kill-path reap below relies on that ownership.
  let sandboxName = '';
  let lineCarry = '';
  let timer;
  let killTimer;
  let idleTimer;
  let sandboxRemoval = null;

  return new Promise((resolve) => {
    const child = spawn(
      options.qwenBin,
      [
        '--yolo',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--prompt',
        prompt,
      ],
      {
        stdio: ['inherit', 'pipe', 'pipe'],
        detached: true,
      },
    );

    const appendDiagnostic = (text) => {
      diagnosticTail = (diagnosticTail + text).slice(-20_000);
    };

    const consumeStreamJsonLine = (line, terminated) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        lastOutputAt = Date.now();
        if (event?.type === 'result') terminalResult = event;
        if (event?.type !== 'stream_event') {
          process.stdout.write(`${line}${terminated ? '\n' : ''}`);
        }
      } catch {
        appendDiagnostic(`${line}${terminated ? '\n' : ''}`);
        process.stdout.write(`${line}${terminated ? '\n' : ''}`);
      }
    };

    const consumeStreamJson = (text, final = false) => {
      const parts = text.split('\n');
      for (const [index, part] of parts.entries()) {
        const terminated = index < parts.length - 1;
        if (!discardingOversizedStdoutLine) {
          const remaining = MAX_STREAM_JSON_LINE_LENGTH - stdoutCarry.length;
          if (part.length <= remaining) {
            stdoutCarry += part;
          } else {
            stdoutCarry = '';
            discardingOversizedStdoutLine = true;
          }
        }
        if (terminated) {
          if (discardingOversizedStdoutLine) {
            process.stdout.write(OVERSIZED_STREAM_JSON_LINE_NOTICE);
          } else {
            consumeStreamJsonLine(stdoutCarry, true);
          }
          stdoutCarry = '';
          discardingOversizedStdoutLine = false;
        }
      }
      if (final) {
        if (discardingOversizedStdoutLine) {
          process.stdout.write(OVERSIZED_STREAM_JSON_LINE_NOTICE);
        } else {
          consumeStreamJsonLine(stdoutCarry, false);
        }
        stdoutCarry = '';
        discardingOversizedStdoutLine = false;
      }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearInterval(idleTimer);
      consumeStreamJson('', true);
      const terminalOutput = streamResultOutput(terminalResult);
      const apiErrorInfo = recoverableApiError(
        result.status === 0
          ? terminalOutput
          : `${diagnosticTail}\n${terminalOutput}`,
      );
      const payload = {
        ...result,
        timedOut,
        idleTimedOut,
        loopDetected: isLoopGuardResult(terminalResult),
        // A RECOVERABLE model error means qwen never evaluated the feedback —
        // the workflow retries it rather than advancing the watermark.
        apiError: apiErrorInfo.error,
        apiErrorKind: apiErrorInfo.kind,
        sandboxRemoval,
      };
      if (log.destroyed) {
        resolve(payload);
      } else {
        log.end(() => resolve(payload));
      }
    };

    const record = (chunk, stream, source) => {
      const text = chunk.toString('utf8');
      if (!sandboxName) {
        lineCarry += text;
        const lastNewline = lineCarry.lastIndexOf('\n');
        if (lastNewline === -1) {
          lineCarry = lineCarry.slice(-256);
        } else {
          const complete = lineCarry.slice(0, lastNewline + 1);
          lineCarry = lineCarry.slice(lastNewline + 1).slice(-256);
          const name = complete.match(
            /^ContainerName(?: \(regular\))?: (\S+)$/m,
          )?.[1];
          if (name && /^qwen-code-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
            sandboxName = name;
          }
        }
      }
      if (source === 'stdout') {
        consumeStreamJson(text);
      } else {
        lastOutputAt = Date.now();
        appendDiagnostic(text);
        stream.write(chunk);
      }
      log.write(chunk);
    };

    child.stdout.on('data', (chunk) => record(chunk, process.stdout, 'stdout'));
    child.stderr.on('data', (chunk) => record(chunk, process.stderr, 'stderr'));
    child.on('error', (error) => finish({ error, status: null, signal: null }));
    child.on('close', (status, signal) =>
      finish({ error: null, status, signal }),
    );

    // Killing the host-side docker client leaves the sandbox container
    // RUNNING on this persistent runner, and the startup reaper may not
    // touch running containers (one can belong to a concurrent job on
    // another registration of the same host). Remove it HERE, where
    // ownership is unambiguous: the name was captured from this run's own
    // launcher line. Best-effort — a daemon blip must not mask the kill.
    const escalateKill = () => {
      killQwen(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) killQwen(child, 'SIGKILL');
      }, 10_000);
      if (sandboxName) {
        // Async, not spawnSync: a synchronous removal blocks the event loop
        // for up to the spawn timeout, holding up the SIGKILL backstop
        // queued above and the child's close/finish/log-flush — in exactly
        // the wedged-daemon scenario this kill path exists for. The main
        // flow awaits sandboxRemoval, so the leak warning and the kill-path
        // reap stay deterministic without blocking the backstop.
        const rm = spawn('docker', ['rm', '-f', '--', sandboxName], {
          stdio: 'ignore',
          timeout: 30_000,
        });
        sandboxRemoval = new Promise((resolveRemoval) => {
          let warned = false;
          const warnLeak = () => {
            if (warned) return;
            warned = true;
            process.stderr.write(
              `warning: leaked sandbox container ${sandboxName} could not be removed; it keeps running on this host\n`,
            );
          };
          rm.on('error', warnLeak);
          rm.on('close', (code) => {
            if (code !== 0) warnLeak();
            resolveRemoval();
          });
        });
      }
    };

    timer = setTimeout(() => {
      timedOut = true;
      escalateKill();
    }, QWEN_TIMEOUT_MS);
    // Poll rather than reset-a-timeout-per-chunk: chunks arrive far more
    // often than the watchdog needs to look, and a busy stream would then
    // spend its time re-arming timers. The tick shrinks with the window so
    // tiny test values still fire promptly.
    const idleTick = Math.max(
      250,
      Math.min(30_000, Math.floor(QWEN_IDLE_TIMEOUT_MS / 4)),
    );
    idleTimer = setInterval(() => {
      if (settled || timedOut || idleTimedOut) return;
      if (Date.now() - lastOutputAt >= QWEN_IDLE_TIMEOUT_MS) {
        idleTimedOut = true;
        timedOut = true;
        escalateKill();
      }
    }, idleTick);
  });
}

function promptFor(options, spec) {
  const skill = readFileSync(skillPath, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '')
    .trim();
  return [
    `Skill directory: ${dirname(skillPath)}`,
    'Resolve skill-relative paths from that directory.',
    '',
    skill,
    '',
    `Mode: ${options.mode}`,
    'Invocation:',
    spec.invocation(options),
    '',
  ].join('\n');
}

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'main' },
    conflict: { type: 'string', default: 'false' },
    issue: { type: 'string' },
    mode: { type: 'string' },
    pr: { type: 'string' },
    'print-prompt': { type: 'boolean', default: false },
    'qwen-bin': { type: 'string', default: 'qwen' },
    workdir: { type: 'string', default: '/tmp/autofix' },
  },
});
const options = {
  ...values,
  printPrompt: values['print-prompt'],
  qwenBin: values['qwen-bin'],
};
const spec = specs[options.mode];
if (!spec) fail(`--mode must be one of: ${Object.keys(specs).join(', ')}`);
if (!['true', 'false'].includes(options.conflict)) {
  fail('--conflict must be true or false');
}
for (const key of spec.required ?? []) {
  if (!options[key]) fail(`--${key} is required for ${options.mode}`);
}

const prompt = promptFor(options, spec);
if (options.printPrompt) {
  process.stdout.write(prompt);
  process.exit(0);
}

const missingInputs = missing(options.workdir, spec.inputs);
if (missingInputs.length > 0) {
  fail(
    `Missing input file(s) in ${options.workdir}: ${missingInputs.join(', ')}`,
  );
}

const result = await runQwen(options, prompt);
// Await the kill-path container removal (bounded by its own 30s spawn
// timeout) so the leak warning and the removal itself settle before this
// process exits and the next step inspects the host.
if (result.sandboxRemoval) await result.sandboxRemoval;
const missingOutputs = missing(options.workdir, spec.outputs);
const presentOutputs = spec.outputs.filter(
  (name) => !missingOutputs.includes(name),
);
const hasOutputVerdict = spec.anyOutput
  ? presentOutputs.length > 0
  : missingOutputs.length === 0;
const apiErrorWithoutVerdict =
  result.status === 0 &&
  result.apiError &&
  !hasOutputVerdict &&
  !existsSync(file(options.workdir, 'failure.md'));
if (
  result.error ||
  result.signal ||
  result.status !== 0 ||
  apiErrorWithoutVerdict
) {
  const detail = result.error
    ? result.error.message
    : result.idleTimedOut
      ? `idle-timeout (no output for ${QWEN_IDLE_TIMEOUT_MS}ms — the sandbox likely hung at startup)`
      : result.timedOut
        ? `timeout (${QWEN_TIMEOUT_MS}ms)`
        : result.signal
          ? `signal ${result.signal}`
          : apiErrorWithoutVerdict
            ? 'recoverable API error without an agent verdict'
            : `status ${String(result.status)}`;
  if (!existsSync(file(options.workdir, 'failure.md'))) {
    if (result.loopDetected) {
      writeFailure(
        options.workdir,
        `Qwen hit the tool-call loop guard during ${options.mode}. A human should take over this feedback batch.`,
      );
      writeHandoff(
        options.workdir,
        'Qwen hit the tool-call loop guard; a human should take over this feedback batch.',
      );
    } else {
      writeFailure(
        options.workdir,
        `Qwen failed during ${options.mode}: ${detail}.${
          result.apiError ? ` ${result.apiError}` : ''
        }`,
      );
      // A TIMEOUT evaluated NOTHING — the agent ran out of budget before
      // finishing, so nothing was committed and the feedback is UNaddressed.
      // Treat it like any other pre-verdict failure and RETRY (the workflow
      // stamps a sentinel ts) rather than advancing the watermark and
      // stranding the feedback the loop never actually handled. This is
      // transient far more often than not — on a heavily-reviewed PR a
      // timed-out round is usually followed by a successful one (#7471:
      // rounds 11/13 timed out, 12 pushed) — and a PR that PERSISTENTLY times
      // out is bounded by the consecutive-failure cap, not by one-shot
      // terminal. A loop guard stays terminal (a tool-call loop is a real
      // defect, not a budget blip), handled by the loopDetected branch above.
      if (result.timedOut) {
        writeFileSync(file(options.workdir, 'agent-timeout'), `${detail}\n`);
      }
      // Only a BARE, un-evaluated API failure is retryable. An agent-written
      // failure.md is a real verdict — left terminal even if an API-error
      // string appears in the output tail. Signals the workflow to retry
      // (sentinel ts) instead of advancing the watermark and stranding the PR.
      if (result.apiError && !result.timedOut) {
        writeFileSync(
          file(options.workdir, 'agent-api-error'),
          `${result.apiError}\n`,
        );
        // Cause class ("transient" | "auth") — the handoff step gives a
        // self-healing transient error the full round budget, but caps an
        // auth/access error that only a maintainer can fix.
        writeFileSync(
          file(options.workdir, 'agent-api-error-kind'),
          `${result.apiErrorKind}\n`,
        );
      }
    }
  } else {
    writeHandoff(
      options.workdir,
      'The agent wrote failure.md before qwen exited; a human should take over this feedback batch.',
    );
    console.error(
      `Qwen failed during ${options.mode}: ${detail}; preserving agent-written failure.md.`,
    );
  }
  process.exit(result.status === 0 ? 1 : (result.status ?? 1));
}

if (existsSync(file(options.workdir, 'failure.md'))) {
  const content = readFileSync(file(options.workdir, 'failure.md'), 'utf8');
  writeHandoff(
    options.workdir,
    'The agent wrote failure.md; a human should take over this feedback batch.',
  );
  console.error(`Autofix agent wrote failure.md:\n${content}`);
  process.exit(0);
}

if (spec.exclusiveOutput && presentOutputs.length > 1) {
  const message = `Autofix agent wrote mutually exclusive output files: ${presentOutputs.join(', ')}.`;
  writeFailure(options.workdir, message);
  fail(message);
}
const ok = hasOutputVerdict;
if (!ok) {
  const message = `Autofix agent finished without required output file(s): ${missingOutputs.join(', ')}.`;
  writeFailure(options.workdir, message);
  fail(message);
}

console.log(`Autofix agent completed ${options.mode} successfully.`);
