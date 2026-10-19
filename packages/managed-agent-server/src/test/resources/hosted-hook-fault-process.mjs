// FG13c (issue #14449): the managed command-Hook fixture. A Hook is a
// decision gate with a process behind it, so the fault cells need a command
// that can hold while a descendant keeps its cgroup unit populated, and one
// that dies on SIGKILL while it runs.
import { spawn } from 'node:child_process';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

const [mode, evidence, holdMsRaw = '0', signalMode = 'default'] =
  process.argv.slice(2);
const holdMs = Number(holdMsRaw);
const stat = () =>
  readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ')[19];

function append(file, value) {
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function record(event, fields = {}) {
  append(evidence, {
    event,
    pid: process.pid,
    parentPid: process.ppid,
    startTicks: stat(),
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    cgroup: readFileSync('/proc/self/cgroup', 'utf8').trim(),
    ...fields,
  });
}

const solo = signalMode === 'hook-solo' || signalMode === 'hook-deny';

if (mode === 'child') {
  // FG13d: the graceful pass signals every member; this descendant has to
  // survive it so only the unit-wide cgroup.kill can empty the unit.
  if (signalMode === 'hook-ignore-term') process.on('SIGTERM', () => {});
  record('hook.child');
  setInterval(() => {}, 1000);
} else if (mode === 'hook') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const value = JSON.parse(input);
  // FG13d: lifecycle events (SessionEnd/SessionDelete) must not answer with a
  // PreToolUse decision, so the fixture only records their completion. Match
  // the two names positively: an absent or renamed event must not take this
  // path and silently exit without a decision.
  const lifecycle = ['SessionEnd', 'SessionDelete'].includes(
    value.hook_event_name,
  );
  record('hook.call', { eventName: value.hook_event_name, input: value });
  let child;
  if (!solo && !lifecycle) {
    child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        'child',
        evidence,
        holdMsRaw,
        signalMode,
      ],
      { stdio: 'ignore' },
    );
    record('hook.hold', { childPid: child.pid });
  }
  if (Number.isFinite(holdMs) && holdMs >= 0) {
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  } else {
    // An indefinite hold must suspend this branch: setInterval alone keeps
    // the process alive but lets execution fall through to the allow.
    await new Promise(() => setInterval(() => {}, 1000));
  }
  // The runner knows a finished command only when its unit is empty, so the
  // fixture's own descendant has to die before the allow is written.
  if (child) {
    child.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const deny = signalMode === 'hook-deny';
  record(lifecycle ? 'hook.done' : deny ? 'hook.deny' : 'hook.allow', {
    eventName: value.hook_event_name,
  });
  if (lifecycle) process.exit(0);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: deny ? 'deny' : 'allow',
        permissionDecisionReason: deny ? 'FG13_DENIED' : 'FG13_ALLOWED',
      },
    }),
  );
} else {
  throw new Error(`Unknown fixture mode: ${mode}`);
}
