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
let logBytes = 0;
function record(data) {
  if (logBytes >= MAX_LOG) return;
  const line = JSON.stringify({ time: new Date().toISOString(), ns: String(process.hrtime.bigint()), pid: process.pid, ...data }) + '\n';
  if (logBytes + Buffer.byteLength(line) > MAX_LOG) return;
  try { fs.appendFileSync(file, line); logBytes += Buffer.byteLength(line); } catch {}
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
  const load = Module._load, observed = new WeakSet();
  Module._load = function (request, ...args) {
    const target = typeof request === 'string' && (request.startsWith('@lydell/node-pty') || request === 'node-pty');
    let exported;
    try { exported = load.call(this, request, ...args); }
    catch (error) { if (target) record({ event: 'pty_load_failed', backend: request.startsWith('@lydell/') ? '@lydell/node-pty' : 'node-pty' }); throw error; }
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
