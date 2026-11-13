import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const cli = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !fs.existsSync(cli)) throw new Error('Usage: node run.mjs /absolute/path/to/qwen/cli.js [output-directory]');
const out = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(os.tmpdir(), 'qwen17040-'));
const workspace = path.join(out, 'workspace'), home = path.join(out, 'home'), trace = path.join(out, 'trace');
for (const dir of [workspace, home, trace]) fs.mkdirSync(dir, { recursive: true });
const download = path.join(workspace, 'catalog.json');
fs.rmSync(download, { force: true });
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'openai' }, folderTrust: { enabled: false } }, model: { name: 'mock-model' }, mcpServers: {} }));
const cert = path.join(out, 'cert.pem'), key = path.join(out, 'key.pem');
const gitOpenSSL = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe');
const openssl = process.env.QWEN17040_OPENSSL ?? (process.platform === 'win32' && fs.existsSync(gitOpenSSL) ? gitOpenSSL : 'openssl');
const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=raw.githubusercontent.com', '-addext', 'subjectAltName=DNS:raw.githubusercontent.com'], { stdio: 'ignore', timeout: 15000 });
if (generated.status !== 0) throw new Error('Cannot generate test certificate; set QWEN17040_OPENSSL to an OpenSSL executable.');

const promptDelayMs = Number(process.env.QWEN17040_FIRST_PROMPT_DELAY_MS ?? 0);
const instrumented = process.env.QWEN17040_DISABLE_PRELOAD !== '1';
const summary = { node: process.version, platform: process.platform, arch: process.arch, osRelease: os.release(), firstPromptDelayMs: promptDelayMs, instrumented, out, started: new Date().toISOString(), downloadComplete: false, shellExitCode: null, shellSucceeded: false, turnComplete: false, sessionDied: false, statsFailures: 0, permissionFallbacks: 0, shellProgress: [], signals: [] };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const tlsServer = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => {
  res.writeHead(200, { 'content-length': 831741, 'content-type': 'application/json' });
  let remaining = 831741;
  summary.downloadStarted = new Date().toISOString();
  const timer = setInterval(() => { const n = Math.min(1849, remaining); res.write(Buffer.alloc(n, 32)); remaining -= n; if (!remaining) { clearInterval(timer); res.end(); summary.downloadComplete = true; summary.downloadEnded = new Date().toISOString(); } }, 100);
  res.on('close', () => clearInterval(timer));
});
const tlsPort = await listen(tlsServer);
let command;
const proxy = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw), tools = body.tools ?? [];
  const schema = tools.find(t => t.function?.name === 'respond_in_schema')?.function.parameters;
  const classifier = Boolean(schema?.properties?.shouldBlock);
  const main = tools.some(t => t.function?.name === 'run_shell_command');
  const toolResult = body.messages?.some(m => m.role === 'tool');
  const call = (name, args) => ({ id: classifier ? 'classify17040' : 'curl17040', type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const message = classifier ? { role: 'assistant', content: null, tool_calls: [call('respond_in_schema', { shouldBlock: false })] } : main && !toolResult ? { role: 'assistant', content: null, tool_calls: [call('run_shell_command', { command, timeout: 60000, description: 'Issue 17040 controlled slow HTTPS download' })] } : { role: 'assistant', content: 'ISSUE17040_DONE' };
  const finish = message.tool_calls ? 'tool_calls' : 'stop';
  const common = { id: 'chatcmpl17040', created: Math.floor(Date.now() / 1000), model: body.model, usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }] })); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = { ...message }; if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((t, index) => ({ ...t, index }));
  res.write('data: ' + JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
const tunnels = new Set();
proxy.on('connect', (req, client, head) => {
  if (req.url !== 'raw.githubusercontent.com:443') { client.destroy(); return; }
  summary.connectTarget = req.url;
  const upstream = net.connect(tlsPort, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
  for (const socket of [client, upstream]) { tunnels.add(socket); socket.on('close', () => tunnels.delete(socket)); socket.on('error', () => { client.destroy(); upstream.destroy(); }); }
});
const proxyPort = await listen(proxy);
const quoted = value => '"' + value.replaceAll('"', '') + '"';
command = `${process.platform === 'win32' ? 'curl.exe' : 'curl'} -sS --cacert ${quoted(cert)} --proxy http://127.0.0.1:${proxyPort} --connect-timeout 25 --max-time 60 -o ${quoted(download)} -w "catalog http=%{http_code} size=%{size_download}\\n" https://raw.githubusercontent.com/Pal-AI-Lab/cortico-extensions/main/catalog.json`;
const preload = fileURLToPath(new URL('./wire-preload.cjs', import.meta.url)).replaceAll('\\', '/');
const env = { ...process.env, QWEN_HOME: home, QWEN_RUNTIME_DIR: path.join(out, 'runtime'), QWEN17040_TRACE_DIR: trace, OPENAI_API_KEY: 'sk-mock', OPENAI_BASE_URL: `http://127.0.0.1:${proxyPort}/v1`, OPENAI_MODEL: 'mock-model', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''}${instrumented ? ` --require ${JSON.stringify(preload)}` : ''}` };
const daemon = spawn(process.execPath, [cli, 'serve', '--port', '0', '--workspace', workspace, '--no-web'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
summary.daemonPid = daemon.pid;
let interval, abort, eventTask;
try {
  const port = await new Promise((resolve, reject) => {
    let text = '';
    const deadline = setTimeout(() => reject(new Error('daemon startup deadline')), 20000);
    daemon.once('exit', () => { clearTimeout(deadline); reject(new Error('daemon exited before listening')); });
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => { text = (text + String(chunk)).slice(-4096); const match = text.match(/qwen serve listening on http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(deadline); resolve(Number(match[1])); } if (String(chunk).includes('channel liveness failed')) summary.signals.push({ time: new Date().toISOString(), kind: 'channel_liveness_failed' }); });
  });
  const base = `http://127.0.0.1:${port}`, jsonHeaders = { 'content-type': 'application/json' };
  const create = await fetch(base + '/session', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ cwd: workspace, approvalMode: 'auto', sessionScope: 'thread' }), signal: AbortSignal.timeout(30000) });
  assert.equal(create.status, 200, 'session creation must succeed');
  const session = await create.json(); summary.sessionId = session.sessionId;
  const headers = { ...jsonHeaders, 'x-qwen-client-id': session.clientId }, root = base + '/session/' + session.sessionId;
  abort = new AbortController();
  eventTask = fetch(root + '/events', { headers, signal: abort.signal }).then(async response => {
    let buffer = ''; const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end; (end = buffer.indexOf('\n\n')) >= 0;) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const line = frame.split('\n').find(l => l.startsWith('data: ')); if (!line) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === 'session_died') summary.sessionDied = true;
        if (event.type === 'turn_complete' && event.data?.stopReason === 'end_turn') summary.turnComplete = true;
        const update = event.data?.update;
        if (update?.toolCallId === 'curl17040' && update.rawOutput?.type === 'shell_result') { const result = update.rawOutput; summary.shellExitCode = result.exitCode; summary.shellSucceeded = update.status === 'completed' && result.exitCode === 0 && result.outcome === 'completed' && !result.error && result.output?.includes('catalog http=200 size=831741'); }
        if (update?._meta?.shellProgress && summary.shellProgress.length < 20) summary.shellProgress.push(update._meta.shellProgress.elapsedMs);
        if (event.type === 'permission_request') { summary.permissionFallbacks++; await fetch(root + '/permission/' + event.data.requestId, { method: 'POST', headers, body: JSON.stringify({ outcome: { outcome: 'selected', optionId: 'proceed_once' } }) }); }
      }
    }
  }).catch(error => { if (error.name !== 'AbortError') summary.eventError = error.name; });
  interval = setInterval(async () => { try { const response = await fetch(root + '/stats', { headers, signal: AbortSignal.timeout(12000) }); if (response.status !== 200) summary.statsFailures++; } catch { summary.statsFailures++; } }, 2000);
  await new Promise(resolve => setTimeout(resolve, promptDelayMs));
  summary.promptSentAt = new Date().toISOString();
  const response = await fetch(root + '/prompt', { method: 'POST', headers, body: JSON.stringify({ prompt: [{ type: 'text', text: 'Run the single controlled download shell command.' }] }), signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 202, 'prompt must be admitted');
  const end = Date.now() + 150000;
  while (!summary.turnComplete && !summary.sessionDied && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 200));
  clearInterval(interval); abort.abort(); await eventTask;
  assert.equal(summary.sessionDied, false, 'session must remain alive');
  assert.equal(summary.downloadComplete, true, 'download server must finish this run');
  assert.equal(summary.shellSucceeded, true, 'shell result must have exit 0 and expected curl output');
  assert.equal(summary.turnComplete, true, 'turn must finish normally');
  assert.equal(summary.statsFailures, 0, 'stats must stay responsive');
  assert.equal(fs.statSync(download).size, 831741, 'fresh downloaded file must have exact size');
  summary.status = 'PASS';
} catch (error) { summary.status = 'FAIL'; summary.failure = error.message; process.exitCode = 1; }
finally {
  clearInterval(interval); abort?.abort(); await eventTask;
  if (daemon.exitCode === null && daemon.signalCode === null) {
    if (process.platform === 'win32') {
      const stopped = spawnSync('taskkill.exe', ['/PID', String(daemon.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
      summary.cleanup = { method: 'owned-daemon-process-tree', exitCode: stopped.status };
    } else {
      daemon.kill('SIGTERM');
      await Promise.race([new Promise(resolve => daemon.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 10000))]);
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
      summary.cleanup = { method: 'daemon-sigterm', forced: daemon.signalCode === 'SIGKILL' };
    }
  } else summary.cleanup = { method: 'daemon-already-exited', descendantsUnverified: true };
  for (const socket of tunnels) socket.destroy();
  proxy.closeAllConnections(); tlsServer.closeAllConnections(); proxy.close(); tlsServer.close();
  summary.finished = new Date().toISOString();
  summary.traceFiles = fs.readdirSync(trace).filter(name => name.endsWith('.jsonl'));
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
