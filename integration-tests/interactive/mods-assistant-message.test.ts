/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A Mod's `ui.render` hook on reply rows in the Ink terminal, on the built CLI
 * in a real terminal: once a reply block is complete, the row shows the text
 * the hook passed down, here from a model call another Mod answers, while the
 * stored reply and what the model reads next keep the original.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { InteractiveSession } from './interactive-session.js';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';
import { removeScratchDir } from '../scratch-dir.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bundle = join(repo, 'dist/cli.js');
const renderer = pickE2eRenderer();
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(root, entry.name))
      : [join(root, entry.name)],
  );
}

type Message = { role: string; content?: unknown };
// A reply block of several paragraphs and a fenced block with a tab.
const reply = (n: number) =>
  `Answer ${n} reads plainly.\n\nSecond paragraph ${n}.\n\n\`\`\`sh\n\techo ${n}\n\`\`\``;
const text = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? '').join('\n')
      : '';

describe(`Reply rows in the ${renderer} terminal`, () => {
  let server: FakeOpenAIServer | undefined;
  let session: InteractiveSession | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    await server?.close();
    server = undefined;
    if (scratch) await removeScratchDir(scratch);
    scratch = undefined;
  });

  async function start(plugins: Record<string, string>) {
    scratch = mkdtempSync(
      join(tmpdir(), `qwen-mods-assistant-message-${renderer}-`),
    );
    const workspace = join(scratch, 'workspace');
    const qwenHome = join(scratch, 'home');
    const env = {
      PATH: process.env['PATH'],
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      HOME: join(scratch, 'os-home'),
      QWEN_HOME: qwenHome,
      QWEN_RUNTIME_DIR: join(scratch, 'runtime'),
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
      QWEN_CODE_DISABLE_CRON: '1',
      QWEN_CODE_DISABLE_UPDATE_CHECK: '1',
      QWEN_SANDBOX: 'false',
    };
    for (const directory of [workspace, qwenHome, env.HOME])
      mkdirSync(directory, { recursive: true });
    json(join(qwenHome, 'settings.json'), {
      experimental: { mods: true },
      general: {
        enableAutoUpdate: false,
        chatRecording: true,
        showSessionRecap: false,
      },
      ui: { enableFollowupSuggestions: false },
      memory: E2E_MEMORY_SETTINGS_DEFAULTS,
      security: {
        folderTrust: { enabled: true },
        auth: { selectedType: 'openai' },
      },
    });
    json(join(qwenHome, 'trustedFolders.json'), {
      [workspace]: 'TRUST_FOLDER',
    });

    let answered = 0;
    server = await startFakeOpenAIServer(({ body }) =>
      body['stream'] === true
        ? { content: reply(++answered) }
        : { content: '{}' },
    );
    const cli = resolveE2eCliCommand(renderer);
    for (const [name, hooks] of Object.entries(plugins)) {
      const plugin = join(scratch, name);
      mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
      mkdirSync(join(plugin, 'hooks'), { recursive: true });
      json(join(plugin, '.claude-plugin/plugin.json'), {
        name,
        version: '1.0.0',
      });
      json(join(plugin, 'hooks/hooks.json'), { modules: ['./register.js'] });
      writeFileSync(
        join(plugin, 'hooks/register.js'),
        `export function register(on) { ${hooks} }`,
      );
      execFileSync(
        cli,
        [bundle, 'extensions', 'install', plugin, '--consent'],
        { cwd: workspace, env, timeout: 60_000, stdio: 'pipe' },
      );
    }
    session = await InteractiveSession.start({
      cols: 160,
      rows: 50,
      cwd: workspace,
      env,
      inheritEnv: false,
      command: {
        bin: cli,
        args: [
          bundle,
          '--auth-type',
          'openai',
          '--model',
          'fixture',
          '--openai-base-url',
          server.baseUrl,
          '--openai-api-key',
          'fixture',
        ],
      },
    });
    await session.idle(1000, 20_000);
    return session;
  }

  /** Every message of the last main-conversation model request. */
  const lastRequest = () =>
    (
      (server!.requests
        .filter((request) => request.body['stream'] === true)
        .at(-1)?.body['messages'] ?? []) as Message[]
    ).map((message) => `${message.role}: ${text(message.content)}`);

  const storedReplies = () =>
    files(scratch!)
      .filter((file) => file.endsWith('.jsonl'))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      )
      .filter((record) => record['type'] === 'assistant')
      .map((record) => JSON.stringify(record['message']));

  it('shows the text a hook rewrote once the block is complete, and keeps the original', async () => {
    // The first reply is drawn longer than it was, the second shorter, so
    // the rows above the bottom change height.
    const nonce = randomUUID().slice(0, 8);
    const terminal = await start({
      // Answers every model call itself, so no provider is asked.
      'upper-model': `
        on('model.complete', ($, e) => ({ value: { isAnswered: true,
          text: e.prompt.toUpperCase(), usage: { input_tokens: 0, output_tokens: 0,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }));`,
      // Marks each row with the session that drew it: s1, s2, ...
      'shout-rows': `
        const sessions = [];
        const rowsBySession = new Map();
        on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
          const session = await $.session.id();
          if (!sessions.includes(session)) sessions.push(session);
          const rows = rowsBySession.get(session) ?? [];
          rows.push(e.props.text);
          rowsBySession.set(session, rows);
          const r = await $.model.complete({ model: 'haiku', prompt: e.props.text });
          if (!r.isAnswered) return next(e);
          const text = r.text.includes('ANSWER 1')
            ? r.text + '\\n\\nExtra line A.\\n\\nExtra line B.'
            : r.text.split('\\n\\n')[0];
          // The session after /clear draws only its own transcript.
          const afterClear = r.text.includes('ANSWER 3')
            ? (rows.every((row) => row.includes('Answer 3')) ? ' Clean switch.' : ' Stale switch.')
            : '';
          const mark = 's' + (sessions.indexOf(session) + 1);
          return next({ ...e, props: { ...e.props,
            text: 'Shouted ${nonce} ' + mark + ': ' + text + afterClear } });
        });`,
    });

    await terminal.send(`Look ${nonce}`);
    await terminal.waitForScreen(
      (screen) => screen.includes('Extra line B.'),
      'the rewritten reply row',
      60_000,
    );
    const first = await terminal.screen();
    expect(first).toContain(`Shouted ${nonce} s1: ANSWER 1 READS PLAINLY.`);
    expect(first).toContain('ECHO 1');
    expect(first).not.toContain('Answer 1 reads plainly.');

    // The stored reply and what the model reads next keep the original.
    await terminal.idle(300, 20_000);
    await terminal.send(`Again ${nonce}`);
    await terminal.waitForScreen(
      (screen) =>
        screen.includes(`Shouted ${nonce} s1: ANSWER 2 READS PLAINLY.`) &&
        !screen.includes('Second paragraph 2.'),
      'the second rewritten row',
      60_000,
    );
    // Every row is whole, once, and in order around the rows that changed.
    const screen = await terminal.screen();
    const order = [
      `Look ${nonce}`,
      `Shouted ${nonce} s1: ANSWER 1 READS PLAINLY.`,
      'SECOND PARAGRAPH 1.',
      'ECHO 1',
      'Extra line A.',
      'Extra line B.',
      `Again ${nonce}`,
      `Shouted ${nonce} s1: ANSWER 2 READS PLAINLY.`,
    ];
    for (const line of order)
      expect(screen.split(line).length - 1, line).toBe(1);
    const at = order.map((line) => screen.indexOf(line));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(screen).not.toContain('SECOND PARAGRAPH 2');
    expect(lastRequest().join('\n')).toContain(
      'assistant: Answer 1 reads plainly.\n\nSecond paragraph 1.',
    );
    expect(lastRequest().join('\n')).not.toContain('Shouted');
    expect(storedReplies().join('\n')).toContain('Answer 1 reads plainly.');
    expect(storedReplies().join('\n')).not.toContain('Shouted');

    // The branch's transcript carries both replies, and each is drawn again
    // for the branch's session even where the transcript switched first.
    await terminal.idle(300, 20_000);
    await terminal.send('/branch');
    const branched = await terminal.waitForScreen(
      (screen) =>
        screen.includes(`Shouted ${nonce} s2: ANSWER 1 READS PLAINLY.`) &&
        screen.includes(`Shouted ${nonce} s2: ANSWER 2 READS PLAINLY.`),
      'the inherited rows drawn for the branch',
      60_000,
    );
    expect(branched).not.toContain(`Shouted ${nonce} s1:`);

    await terminal.idle(300, 20_000);
    await terminal.send('/clear');
    await terminal.waitForScreen(
      (screen) =>
        !screen.includes(`Again ${nonce}`) &&
        screen.includes('Type your message'),
      'the cleared transcript',
      60_000,
    );
    await terminal.idle(300, 20_000);
    await terminal.send(`After clear ${nonce}`);
    const afterClear = await terminal.waitForScreen(
      (screen) =>
        screen.includes(`Shouted ${nonce} s3: ANSWER 3 READS PLAINLY.`),
      'the new session reply',
      60_000,
    );
    expect(afterClear).toContain('Clean switch.');
  });
});
