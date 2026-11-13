const { isMainThread } = require('node:worker_threads');
if (!isMainThread || !process.env.QWEN17040_TRACE_DIR) return;

const acp = process.argv.includes('--acp');
if (!acp && !process.argv.includes('serve')) return;
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const Module = require('node:module');
const { syncBuiltinESMExports } = Module;
const dir = process.env.QWEN17040_TRACE_DIR;
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${process.pid}.jsonl`);
const MAX_PREFIX = 64 * 1024;
const MAX_LOG = 2 * 1024 * 1024;
let logBytes = 0, recording = false;
function record(data) {
  if (recording || logBytes >= MAX_LOG) return;
  const line = JSON.stringify({ time: new Date().toISOString(), ns: String(process.hrtime.bigint()), pid: process.pid, ...data }) + '\n';
  if (logBytes + Buffer.byteLength(line) > MAX_LOG) return;
  try { recording = true; fs.appendFileSync(file, line); logBytes += Buffer.byteLength(line); } catch {} finally { recording = false; }
}
function metadata(prefix, bytes) {
  try {
    let text = prefix.toString('utf8');
    if (bytes > MAX_PREFIX) {
      const payload = text.search(/"(?:params|result|error)"\s*:/);
      if (payload < 0) return { kind: 'oversize' };
      text = text.slice(0, payload).replace(/,\s*$/, '') + '}';
    }
    const object = JSON.parse(text);
    const hasId = Object.hasOwn(object, 'id');
    const method = typeof object.method === 'string' && /^[A-Za-z0-9_./-]{1,160}$/.test(object.method) ? object.method : undefined;
    return {
      kind: method ? hasId ? 'request' : 'notification' : hasId ? 'response' : 'unknown',
      ...(method ? { method } : {}),
      ...(hasId ? { idHash: crypto.createHash('sha256').update(JSON.stringify(object.id)).digest('hex').slice(0, 16) } : {}),
    };
  } catch { return { kind: 'unparsed' }; }
}
function parser(point, childPid) {
  let prefix = Buffer.alloc(0), bytes = 0, frame = 0, startedNs;
  return (chunk, encoding, writeSeq) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : undefined);
    for (let offset = 0; offset < buffer.length;) {
      if (bytes === 0) startedNs = String(process.hrtime.bigint());
      const newline = buffer.indexOf(10, offset);
      const end = newline < 0 ? buffer.length : newline;
      const part = buffer.subarray(offset, end);
      if (prefix.length < MAX_PREFIX) prefix = Buffer.concat([prefix, part.subarray(0, MAX_PREFIX - prefix.length)]);
      bytes += part.length;
      if (newline < 0) break;
      record({ point, event: 'frame', childPid, frame: ++frame, writeSeq, bytes: bytes + 1, startedNs, ...metadata(prefix, bytes) });
      prefix = Buffer.alloc(0); bytes = 0; offset = newline + 1;
    }
  };
}
function observeWrites(stream, point, childPid) {
  const feed = parser(point, childPid), original = stream.write;
  const emit = stream.emit;
  stream.emit = function (event, ...args) {
    if (event === 'drain' || event === 'error' || event === 'close') record({ point, event, childPid, queuedBytes: this.writableLength, needDrain: this.writableNeedDrain });
    return emit.call(this, event, ...args);
  };
  let writeSeq = 0;
  stream.write = function (...args) {
    const seq = ++writeSeq;
    record({ point, event: 'write_call', childPid, writeSeq: seq, queuedBytes: this.writableLength, needDrain: this.writableNeedDrain });
    feed(args[0], args[1], seq);
    const index = typeof args[2] === 'function' ? 2 : typeof args[1] === 'function' ? 1 : -1;
    if (index >= 0) {
      const callback = args[index];
      args[index] = function (...values) { record({ point, event: 'write_callback', childPid, writeSeq: seq, failed: Boolean(values[0]) }); return callback.apply(this, values); };
    }
    const accepted = original.apply(this, args);
    record({ point, event: 'write_return', childPid, writeSeq: seq, accepted, queuedBytes: this.writableLength, needDrain: this.writableNeedDrain });
    return accepted;
  };
}
function observeReads(stream, point, childPid) {
  const feed = parser(point, childPid), original = stream.emit;
  stream.emit = function (event, ...args) {
    if (event === 'data') feed(args[0]);
    return original.call(this, event, ...args);
  };
}
if (acp) {
  record({ event: 'preload', role: 'acp-child' });
  observeReads(process.stdin, 'child_receive');
  observeWrites(process.stdout, 'child_write');
  const { fileURLToPath } = require('node:url');
  const codeRoot = path.dirname(path.resolve(process.argv[1])).replaceAll('\\', '/') + '/';
  function safeFrame(frame) {
    let filename = frame.url ?? '', name;
    if (filename.startsWith('node:')) name = filename;
    else if (filename.startsWith('wasm://')) name = '<wasm>';
    else if (!filename && ['(root)', '(program)', '(idle)', '(garbage collector)'].includes(frame.functionName)) name = '<runtime>';
    else {
      try { if (filename.startsWith('file:')) filename = fileURLToPath(filename); } catch { return; }
      const normalized = filename.replaceAll('\\', '/');
      if (!normalized.startsWith(codeRoot) && path.resolve(filename) !== __filename) return;
      name = normalized.split('/').at(-1);
      if (!/^[A-Za-z0-9_.-]{1,120}$/.test(name)) return;
    }
    return { function: String(frame.functionName || '<anonymous>').replace(/[^A-Za-z0-9_$ .<>:/()\[\]-]/g, '?').slice(0, 96), file: name.slice(0, 160), line: frame.lineNumber >= 0 ? frame.lineNumber + 1 : undefined, column: frame.columnNumber >= 0 ? frame.columnNumber + 1 : undefined };
  }
  function safeStack() {
    const previous = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    try {
      Object.defineProperty(Error, 'prepareStackTrace', { configurable: true, writable: true, value: (_error, sites) => sites });
      const sites = new Error().stack;
      return Array.isArray(sites) ? sites.map(site => safeFrame({ url: site.getFileName(), functionName: site.getFunctionName(), lineNumber: site.getLineNumber() - 1, columnNumber: site.getColumnNumber() - 1 })).filter(Boolean).slice(0, 8) : [];
    } catch { return []; } finally { if (previous) Object.defineProperty(Error, 'prepareStackTrace', previous); else delete Error.prepareStackTrace; }
  }
  for (const api of ['readFileSync', 'statSync', 'accessSync', 'realpathSync', 'writeFileSync', 'writeSync', 'fsyncSync', 'renameSync', 'openSync']) {
    fs[api] = new Proxy(fs[api], { apply(target, receiver, args) {
      const start = process.hrtime.bigint(); let result, threw = true;
      try { result = Reflect.apply(target, receiver, args); threw = false; return result; }
      finally {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        if (durationMs > 500 && !recording) record({ event: 'slow_sync_fs', api, durationMs, threw, bytes: api === 'readFileSync' && ArrayBuffer.isView(result) ? result.byteLength : undefined, chars: api === 'readFileSync' && typeof result === 'string' ? result.length : undefined, stack: safeStack() });
      }
    } });
  }
  let stopProfile = () => {};
  try {
    const session = new (require('node:inspector').Session)();
    session.connect();
    let started = false, stopped = false, fallback;
    stopProfile = reason => {
      if (!started || stopped) return;
      stopped = true; clearTimeout(fallback);
      session.post('Profiler.stop', (error, result) => {
        try {
          if (error || !result?.profile) { record({ event: 'cpu_profile_unavailable', stage: 'stop' }); return; }
          const profile = result.profile, nodes = new Map(profile.nodes.map(node => [node.id, node])), parents = new Map(), totals = new Map(), stacks = new Map();
          for (const node of profile.nodes) for (const id of node.children ?? []) parents.set(id, node.id);
          for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
            const id = profile.samples[index];
            if (!stacks.has(id)) {
              const stack = []; let current = id;
              for (let depth = 0; current !== undefined && depth < 64 && stack.length < 12; depth++, current = parents.get(current)) { const frame = safeFrame(nodes.get(current)?.callFrame ?? {}); if (frame) stack.push(frame); }
              stacks.set(id, stack);
            }
            const stack = stacks.get(id), key = JSON.stringify(stack), weight = profile.timeDeltas?.[index] ?? 0;
            const total = totals.get(key) ?? { stack, samples: 0, selfSampleUs: 0, maxDeltaUs: 0 };
            total.samples++; total.selfSampleUs += weight; total.maxDeltaUs = Math.max(total.maxDeltaUs, weight); totals.set(key, total);
          }
          const top = [...totals.values()].sort((a, b) => b.selfSampleUs - a.selfSampleUs).slice(0, 25).map(({ stack, samples, selfSampleUs, maxDeltaUs }) => ({ stack, samples, selfSampleMs: selfSampleUs / 1000, maxDeltaMs: maxDeltaUs / 1000 }));
          record({ event: 'cpu_profile_summary', reason, durationMs: (profile.endTime - profile.startTime) / 1000, sampleCount: profile.samples?.length ?? 0, top });
        } catch { record({ event: 'cpu_profile_unavailable', stage: 'aggregate' }); } finally { session.disconnect(); }
      });
    };
    session.post('Profiler.enable', error => {
      if (error) { record({ event: 'cpu_profile_unavailable', stage: 'enable' }); session.disconnect(); return; }
      session.post('Profiler.setSamplingInterval', { interval: 10000 }, error => {
        if (error) { record({ event: 'cpu_profile_unavailable', stage: 'interval' }); session.disconnect(); return; }
        session.post('Profiler.start', error => {
          if (error) { record({ event: 'cpu_profile_unavailable', stage: 'start' }); session.disconnect(); return; }
          started = true; record({ event: 'cpu_profile_started', intervalUs: 10000 });
          fallback = setTimeout(() => stopProfile('fallback'), 60000); fallback.unref();
        });
      });
    });
  } catch { record({ event: 'cpu_profile_unavailable', stage: 'setup' }); }
  let sampleNs = process.hrtime.bigint(), sampleCpu = process.cpuUsage(), syncSeq = 0;
  setInterval(() => {
    const now = process.hrtime.bigint(), cpu = process.cpuUsage();
    const elapsedMs = Number(now - sampleNs) / 1e6;
    record({ event: 'event_loop_sample', elapsedMs, lateMs: Math.max(0, elapsedMs - 250), userCpuMs: (cpu.user - sampleCpu.user) / 1000, systemCpuMs: (cpu.system - sampleCpu.system) / 1000, stdinPaused: process.stdin.isPaused(), stdinFlowing: process.stdin.readableFlowing, stdinQueuedBytes: process.stdin.readableLength });
    sampleNs = now; sampleCpu = cpu;
    if (elapsedMs - 250 > 5000) stopProfile('event_loop_stall');
  }, 250).unref();
  for (const api of ['spawnSync', 'execSync', 'execFileSync']) {
    const original = cp[api];
    cp[api] = function (...args) {
      const call = ++syncSeq;
      const name = api !== 'execSync' && typeof args[0] === 'string' ? args[0].split(/[\\/]/).at(-1).toLowerCase() : '';
      const executable = /^(?:(?:powershell|pwsh|cmd|where|wmic|node|git|reg)(?:\.exe)?|chcp(?:\.com)?|sh|sleep)$/.test(name) ? name : undefined;
      record({ event: 'sync_process_start', api, call, executable });
      const started = process.hrtime.bigint(), cpu = process.cpuUsage();
      let threw = true;
      try { const result = original.apply(this, args); threw = false; return result; }
      finally { const used = process.cpuUsage(cpu); record({ event: 'sync_process_end', api, call, durationMs: Number(process.hrtime.bigint() - started) / 1e6, userCpuMs: used.user / 1000, systemCpuMs: used.system / 1000, threw }); }
    };
  }
  const load = Module._load, observed = new WeakSet(); let loadSeq = 0;
  Module._load = function (request, ...args) {
    const target = typeof request === 'string' && (request.startsWith('@lydell/node-pty') || request === 'node-pty');
    const call = target ? ++loadSeq : undefined, started = target ? process.hrtime.bigint() : undefined;
    if (target) record({ event: 'pty_load_start', call, backend: request.startsWith('@lydell/') ? '@lydell/node-pty' : 'node-pty' });
    let exported, failed = true;
    try { exported = load.call(this, request, ...args); failed = false; }
    catch (error) { if (target) record({ event: 'pty_load_failed', backend: request.startsWith('@lydell/') ? '@lydell/node-pty' : 'node-pty' }); throw error; }
    finally { if (target) record({ event: 'pty_load_end', call, durationMs: Number(process.hrtime.bigint() - started) / 1e6, failed }); }
    if (target && exported && typeof exported.spawn === 'function' && !observed.has(exported)) {
      observed.add(exported);
      const spawn = exported.spawn, backend = request.startsWith('@lydell/') ? '@lydell/node-pty' : 'node-pty';
      record({ event: 'pty_loaded', backend });
      exported.spawn = function (...values) {
        const useConptyDll = values[2]?.useConptyDll === true;
        record({ event: 'pty_spawn_call', backend, useConptyDll });
        try { const pty = spawn.apply(this, values); record({ event: 'pty_spawn_return', backend, useConptyDll, childPid: pty.pid }); return pty; }
        catch (error) { record({ event: 'pty_spawn_failed', backend, useConptyDll }); throw error; }
      };
    }
    return exported;
  };
  const spawn = cp.spawn;
  cp.spawn = function (command, ...args) {
    const child = spawn.call(this, command, ...args);
    const shell = String(command).split(/[\\/]/).at(-1).toLowerCase();
    if (['cmd.exe', 'powershell.exe', 'pwsh.exe', 'sh', 'bash', 'zsh'].includes(shell)) record({ event: 'shell_pipe_spawn_return', shell, childPid: child.pid });
    return child;
  };
  syncBuiltinESMExports();
} else {
  record({ event: 'preload', role: 'daemon' });
  const spawn = cp.spawn;
  cp.spawn = function (command, args, options) {
    const target = Array.isArray(args) && args.includes('--acp');
    const child = spawn.call(this, command, target ? ['--require', __filename, ...args] : args, options);
    if (target && child.stdin && child.stdout) {
      record({ event: 'acp_spawn', childPid: child.pid });
      observeWrites(child.stdin, 'daemon_write', child.pid);
      observeReads(child.stdout, 'daemon_receive', child.pid);
    }
    return child;
  };
  syncBuiltinESMExports();
}
