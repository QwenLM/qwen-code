#!/usr/bin/env node
/**
 * Exercises the request capture hook that P0's off-contract depends on.
 *
 * Usage: node scripts/audit/check-request-capture.mjs
 *
 * The gate's whole claim is that with collaboration off, nothing
 * collaboration-shaped reaches the model. That is only checkable if the
 * capture is itself trustworthy, so this runs it against a fake generator:
 * absent env var means no wrapping at all, a set one records the final system
 * instruction, the declared tool names and the session's source type, the
 * request reaches the inner generator untouched, and a capture that throws
 * does not take the turn down with it.
 *
 * Calibrated: dropping tool-name collection turns the tool assertion red, and
 * wrapping regardless of the env var turns the no-op assertion red.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-audit-'));
fs.writeFileSync(
  path.join(tmp, 'entry.ts'),
  `export { RequestCaptureContentGenerator, withRequestCapture, REQUEST_CAPTURE_PATH_ENV } from '${repo}/packages/core/src/core/request-capture-content-generator.js';\n`,
);
execFileSync(
  path.join(repo, 'node_modules/.bin/esbuild'),
  [
    path.join(tmp, 'entry.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=node',
    '--target=node20',
    `--outfile=${path.join(tmp, 'bundle.cjs')}`,
    '--log-level=error',
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
const M = createRequire(import.meta.url)(path.join(tmp, 'bundle.cjs'));

let pass = 0,
  fail = 0;
const ok = (n, c, d = '') => {
  if (c) {
    pass++;
    console.log('  PASS ' + n);
  } else {
    fail++;
    console.log('  FAIL ' + n + (d ? '  → ' + d : ''));
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
const file = path.join(dir, 'requests.jsonl');
const session = {
  getSessionId: () => 'sess_1',
  getSessionSourceType: () => 'agent',
};
const calls = [];
const inner = {
  generateContent: async (r, id) => {
    calls.push(['gc', id]);
    return { text: 'ok' };
  },
  generateContentStream: async (r, id) => {
    calls.push(['gcs', id]);
    return (async function* () {})();
  },
  embedContent: async () => ({ embeddings: [] }),
  countTokens: async () => ({ totalTokens: 7 }),
};

console.log('\n1. 不设环境变量时完全不介入');
delete process.env['QWEN_CODE_CAPTURE_REQUESTS'];
ok('返回的就是原对象', M.withRequestCapture(inner, session) === inner);

console.log('\n2. 设了才包装,并写文件');
process.env['QWEN_CODE_CAPTURE_REQUESTS'] = file;
const wrapped = M.withRequestCapture(inner, session);
ok('包装后不是原对象', wrapped !== inner);

const req = {
  model: 'qwen-max',
  config: {
    systemInstruction: 'You are a careful reviewer.',
    tools: [
      {
        functionDeclarations: [
          { name: 'thread_post' },
          { name: 'read_file' },
          { name: 'thread_wait' },
        ],
      },
    ],
  },
};
const res = await wrapped.generateContent(req, 'prompt-1');
ok('请求被透传给内层', calls.length === 1 && calls[0][1] === 'prompt-1');
ok('内层返回值原样返回', res.text === 'ok');

const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
ok('写了一行', lines.length === 1, String(lines.length));
const e = JSON.parse(lines[0]);
ok(
  '记下 system instruction',
  e.systemInstruction === 'You are a careful reviewer.',
  e.systemInstruction,
);
ok(
  '记下工具名且已排序',
  JSON.stringify(e.toolNames) === '["read_file","thread_post","thread_wait"]',
  JSON.stringify(e.toolNames),
);
ok(
  '记下会话来源类型',
  e.sessionSourceType === 'agent',
  String(e.sessionSourceType),
);
ok('记下方法名', e.method === 'generateContent', e.method);

console.log('\n3. 流式路径同样被记录');
await wrapped.generateContentStream(req, 'prompt-2');
const l2 = fs.readFileSync(file, 'utf-8').trim().split('\n');
ok('追加而非覆盖', l2.length === 2, String(l2.length));
ok('流式方法名正确', JSON.parse(l2[1]).method === 'generateContentStream');

console.log('\n4. 结构化 system instruction 被展平');
await wrapped.generateContent(
  {
    model: 'm',
    config: { systemInstruction: { parts: [{ text: 'A' }, { text: 'B' }] } },
  },
  'prompt-3',
);
const e3 = JSON.parse(fs.readFileSync(file, 'utf-8').trim().split('\n')[2]);
ok(
  'parts 被拼成文本',
  e3.systemInstruction === 'A\nB',
  JSON.stringify(e3.systemInstruction),
);
ok(
  '没有工具时为空数组',
  JSON.stringify(e3.toolNames) === '[]',
  JSON.stringify(e3.toolNames),
);

console.log('\n5. 观测失败不能拖垮被观测的运行');
const broken = M.withRequestCapture(inner, {
  getSessionId: () => {
    throw new Error('boom');
  },
  getSessionSourceType: () => 'agent',
});
let threw = false;
try {
  await broken.generateContent(req, 'prompt-4');
} catch {
  threw = true;
}
ok('记录抛错时请求仍然完成', !threw);

console.log('\n6. countTokens 被转发,不被装饰器吃掉');
ok('转发到内层', (await wrapped.countTokens({})).totalTokens === 7);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
