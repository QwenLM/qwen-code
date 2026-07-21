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
  let outputTail = '';
  let loopDetected = false;
  let settled = false;
  let timedOut = false;
  let timer;
  let killTimer;

  return new Promise((resolve) => {
    const child = spawn(options.qwenBin, ['--yolo', '--prompt', prompt], {
      stdio: ['inherit', 'pipe', 'pipe'],
      detached: true,
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      const apiErrorInfo = recoverableApiError(outputTail);
      const payload = {
        ...result,
        timedOut,
        loopDetected: loopDetected || isLoopGuardOutput(outputTail),
        // A RECOVERABLE model error means qwen never evaluated the feedback —
        // the workflow retries it rather than advancing the watermark.
        apiError: apiErrorInfo.error,
        apiErrorKind: apiErrorInfo.kind,
      };
      if (log.destroyed) {
        resolve(payload);
      } else {
        log.end(() => resolve(payload));
      }
    };

    const record = (chunk, stream) => {
      const text = chunk.toString('utf8');
      outputTail = (outputTail + text).slice(-20_000);
      if (!loopDetected && isLoopGuardOutput(outputTail)) loopDetected = true;
      log.write(chunk);
      stream.write(chunk);
    };

    child.stdout.on('data', (chunk) => record(chunk, process.stdout));
    child.stderr.on('data', (chunk) => record(chunk, process.stderr));
    child.on('error', (error) => finish({ error, status: null, signal: null }));
    child.on('close', (status, signal) =>
      finish({ error: null, status, signal }),
    );

    timer = setTimeout(() => {
      timedOut = true;
      killQwen(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) killQwen(child, 'SIGKILL');
      }, 10_000);
    }, QWEN_TIMEOUT_MS);
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
if (result.error || result.signal || result.status !== 0) {
  const detail = result.error
    ? result.error.message
    : result.timedOut
      ? `timeout (${QWEN_TIMEOUT_MS}ms)`
      : result.signal
        ? `signal ${result.signal}`
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
      // Only a BARE, un-evaluated API failure is retryable. A loop guard, a
      // timeout, or an agent-written failure.md is a real verdict — leave
      // those terminal even if an API-error string appears in the output tail.
      // Signals the workflow to retry (sentinel ts) instead of advancing the
      // watermark and stranding the PR.
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
  process.exit(result.status ?? 1);
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

const missingOutputs = missing(options.workdir, spec.outputs);
const presentOutputs = spec.outputs.filter(
  (name) => !missingOutputs.includes(name),
);
if (spec.exclusiveOutput && presentOutputs.length > 1) {
  const message = `Autofix agent wrote mutually exclusive output files: ${presentOutputs.join(', ')}.`;
  writeFailure(options.workdir, message);
  fail(message);
}
const ok = spec.anyOutput
  ? missingOutputs.length < spec.outputs.length
  : missingOutputs.length === 0;
if (!ok) {
  const message = `Autofix agent finished without required output file(s): ${missingOutputs.join(', ')}.`;
  writeFailure(options.workdir, message);
  fail(message);
}

console.log(`Autofix agent completed ${options.mode} successfully.`);
