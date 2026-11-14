import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { it } from 'vitest';
import { InteractiveSession } from './interactive-session.js';
import { startFakeOpenAIServer } from '../fake-openai-server.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';
import {
  getAutoMemoryRoot,
  getAutoMemoryProjectStateDir,
  getUserAutoMemoryRoot,
  AUTO_MEMORY_INDEX_FILENAME,
} from '@qwen-code/qwen-code-core/memory/paths.js';

const root = path.resolve(import.meta.dirname, '../..');
const renderer = pickE2eRenderer();
const override = process.env['QWEN_MEMORY_COMMAND_JSON'];
const command = override
  ? (JSON.parse(override) as { bin: string; args: string[] })
  : {
      bin: resolveE2eCliCommand(renderer),
      args: [path.join(root, 'dist/cli.js')],
    };
assert(
  command && typeof command.bin === 'string' && Array.isArray(command.args),
);
assert(command.args.every((arg) => typeof arg === 'string'));
if (override) assert(path.isAbsolute(command.bin));
const profile = override
  ? `explicit-${renderer}`
  : `${command.bin}-${renderer}`;
// Every lane that collects `interactive/` reaches this module, and only the
// tui-parity legs export QWEN_TUI_ACCEPTANCE_OUT. Fall back to a repo-relative
// directory like the sibling suites do, so an unset variable is not a
// collection-time failure that reddens the whole lane.
const outputRoot =
  process.env['QWEN_TUI_ACCEPTANCE_OUT'] ??
  path.join(root, '.qwen/e2e-tests/tui-memory-manager');
const names = ['OWNED-CONTEXT-A.md', 'OWNED-CONTEXT-B.md'];
const editMarker = '\nOWNED_MEMORY_EDITOR_PROOF\n';
const toggleKeys = [
  'autoSkillConfirm',
  'enableAutoSkill',
  'enableManagedAutoDream',
  'enableManagedAutoMemory',
] as const;
const toggleLabels = [
  'Confirm auto-skills before saving',
  'Auto-skill',
  'Auto-dream',
  'Auto-memory',
];
type MemoryValues = Record<(typeof toggleKeys)[number], boolean>;
const initialMemory: MemoryValues = {
  enableManagedAutoMemory: true,
  enableManagedAutoDream: false,
  enableAutoSkill: false,
  autoSkillConfirm: true,
};
type ExecEvent = {
  kind: string;
  argv: string[];
  cwd: string;
  pid: number;
  ppid: number;
};

function inventory(
  root: string,
  excluded = new Set<string>(),
): Record<string, unknown> {
  const rows: Record<string, unknown> = {};
  const visit = (file: string) => {
    const stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), 'owned fixture must contain no symlink');
    if (!excluded.has(file)) {
      const relative = path.relative(root, file) || '.';
      if (stat.isDirectory())
        rows[relative] = { type: 'dir', mode: stat.mode & 0o7777 };
      else {
        assert(stat.isFile());
        const bytes = fs.readFileSync(file);
        rows[relative] = {
          type: 'file',
          mode: stat.mode & 0o7777,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          base64: bytes.toString('base64'),
        };
      }
    }
    if (stat.isDirectory())
      for (const name of fs.readdirSync(file).sort())
        visit(path.join(file, name));
  };
  if (fs.existsSync(root)) visit(root);
  return rows;
}
function memoryPanel(viewport: string): string {
  const lines = viewport.split('\n');
  const boxes: string[] = [];
  let start = -1;
  for (let index = 0; index < lines.length; index++) {
    if (/^\s*[╭┌]─{4,}.*[╮┐]\s*$/.test(lines[index])) start = index;
    if (start >= 0 && /^\s*[╰└]─{4,}.*[╯┘]\s*$/.test(lines[index])) {
      const body = lines.slice(start, index + 1).join('\n');
      const numberedLabel = (number: number, label: string) => {
        const rowPattern = new RegExp(
          `^\\s*│\\s*(?:›\\s*)?${number}\\.\\s+${label}\\b(.*)$`,
        );
        const rows = lines.slice(start, index + 1).flatMap((line, row) => {
          const match = rowPattern.exec(line);
          return match ? [{ row: start + row, suffix: match[1] }] : [];
        });
        if (rows.length !== 1) return false;
        const row = rows[0];
        return (
          /^\s+memory(?:\s|│)/.test(row.suffix) ||
          /^\s*│\s*memory(?:\s|│)/.test(lines[row.row + 1] ?? '')
        );
      };
      if (
        body.includes('Memory') &&
        toggleLabels.every((label) => body.includes(label)) &&
        numberedLabel(1, 'User') &&
        numberedLabel(2, 'Project')
      )
        boxes.push(body);
      start = -1;
    }
  }
  return boxes.length === 1 ? boxes[0] : '';
}
function composerRegion(viewport: string): string | null {
  const lines = viewport.split('\n');
  const borders = lines.flatMap((line, index) =>
    /^\s*─{8,}/.test(line) ? [index] : [],
  );
  const regions: string[] = [];
  for (let index = 0; index + 1 < borders.length; index++) {
    const body = lines.slice(borders[index] + 1, borders[index + 1]);
    if (body.length === 1 && /^\s*> /.test(body[0]))
      regions.push(body[0].replace(/^\s*> /, '').trimEnd());
  }
  return regions.length === 1 ? regions[0] : null;
}

async function fixture(
  group: string,
  memory: MemoryValues,
  run: (context: {
    workspace: string;
    home: string;
    memoryBase: string;
    userMemory: string;
    projectMemory: string;
    stateRoot: string;
    workspaceSettings: string;
    legacyUser: string;
    legacyProject: string;
    editorLog: string;
    json: (file: string) => Record<string, unknown>;
    launch: () => Promise<void>;
    quit: () => Promise<void>;
    open: (label: string) => Promise<void>;
    press: (value: string) => Promise<void>;
    panel: (label: string, check: (body: string) => boolean) => Promise<void>;
    composer: (label: string) => Promise<void>;
    events: () => ExecEvent[];
    waitEvents: (count: number) => Promise<void>;
    guard: (label: string, allowed?: string[]) => void;
    save: (name: string, value: unknown) => void;
  }) => Promise<void>,
) {
  assert(
    process.platform !== 'win32',
    'SETUP_NQ: owned editor/opener executable fixture not yet validated on Windows',
  );
  fs.mkdirSync(outputRoot, { recursive: true });
  const output = fs.realpathSync(
    fs.mkdtempSync(path.join(outputRoot, `memory-${group}-`)),
  );
  const home = path.join(output, 'home'),
    runtime = path.join(output, 'runtime'),
    tmp = path.join(output, 'tmp');
  const workspace = path.join(output, 'workspace'),
    bin = path.join(output, 'bin'),
    memoryBase = path.join(output, 'memory-base');
  for (const dir of [home, runtime, tmp, workspace, bin, memoryBase])
    fs.mkdirSync(dir);
  fs.mkdirSync(path.join(workspace, '.qwen'));
  const save = (name: string, value: unknown) =>
    fs.writeFileSync(
      path.join(output, name),
      JSON.stringify(value, null, 2) + '\n',
    );
  const writeJSON = (file: string, value: unknown) =>
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  const json = (file: string) =>
    JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const userSettings = path.join(home, 'settings.json'),
    workspaceSettings = path.join(workspace, '.qwen/settings.json');
  const system = path.join(output, 'system.json'),
    defaults = path.join(output, 'defaults.json'),
    trust = path.join(output, 'trustedFolders.json');
  writeJSON(userSettings, {
    $version: 4,
    general: { preferredEditor: 'vim' },
    context: { fileName: names },
    security: {
      folderTrust: { enabled: true },
      auth: { selectedType: 'openai' },
    },
  });
  writeJSON(workspaceSettings, {
    $version: 4,
    ui: { hideTips: true },
    memory: { ...E2E_MEMORY_SETTINGS_DEFAULTS, ...memory },
  });
  writeJSON(system, { $version: 4 });
  writeJSON(defaults, { $version: 4 });
  writeJSON(trust, { [workspace]: 'TRUST_FOLDER' });
  const fixed = [userSettings, system, defaults, trust].map((file) => ({
    file,
    raw: fs.readFileSync(file, 'base64'),
  }));
  const legacyUser = path.join(home, names[1]),
    legacyProject = path.join(workspace, names[0]);
  fs.writeFileSync(legacyUser, 'USER_CONTEXT_BEFORE\n');
  fs.writeFileSync(
    path.join(workspace, 'unrelated.txt'),
    'WORKSPACE_READ_ONLY\n',
  );
  const oldMemoryEnv = Object.fromEntries(
    [
      'QWEN_CODE_MEMORY_BASE_DIR',
      'QWEN_CODE_MEMORY_LOCAL',
      'QWEN_CODE_MEMORY_PROJECT_SCOPE',
    ].map((key) => [key, process.env[key]]),
  );
  process.env['QWEN_CODE_MEMORY_BASE_DIR'] = memoryBase;
  delete process.env['QWEN_CODE_MEMORY_LOCAL'];
  delete process.env['QWEN_CODE_MEMORY_PROJECT_SCOPE'];
  let userMemory: string, projectMemory: string, stateRoot: string;
  try {
    userMemory = getUserAutoMemoryRoot();
    projectMemory = getAutoMemoryRoot(workspace);
    stateRoot = getAutoMemoryProjectStateDir(workspace);
  } finally {
    for (const [key, value] of Object.entries(oldMemoryEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  fs.mkdirSync(projectMemory, { recursive: true });
  fs.writeFileSync(
    path.join(projectMemory, 'owned-memory.txt'),
    'MANAGED_READ_ONLY\n',
  );
  fs.mkdirSync(stateRoot, { recursive: true });
  writeJSON(path.join(stateRoot, 'meta.json'), {
    version: 1,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    lastDreamAt: '2020-01-01T00:00:00.000Z',
  });
  const editorLog = path.join(output, 'external-events.jsonl');
  const allowedTargets = [
    legacyUser,
    legacyProject,
    path.join(userMemory, AUTO_MEMORY_INDEX_FILENAME),
    path.join(projectMemory, AUTO_MEMORY_INDEX_FILENAME),
  ];
  const externalScript = `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const kind=path.basename(process.argv[1]);const args=process.argv.slice(2);fs.appendFileSync(process.env.QWEN_OWNED_MEMORY_EXEC_LOG,JSON.stringify({kind,argv:args,cwd:process.cwd(),pid:process.pid,ppid:process.ppid})+'\\n');if(args.length!==1||!JSON.parse(process.env.QWEN_OWNED_MEMORY_ALLOWED_TARGETS).includes(args[0]))process.exit(91);if(kind==='vim'){if(process.env.QWEN_OWNED_MEMORY_EDITOR_FAILURE==='1')process.exit(7);fs.appendFileSync(args[0],${JSON.stringify(editMarker)});}process.exit(0);\n`;
  for (const name of ['vim', 'open', 'xdg-open'])
    fs.writeFileSync(path.join(bin, name), externalScript, { mode: 0o700 });
  const events = (): ExecEvent[] =>
    fs.existsSync(editorLog)
      ? fs
          .readFileSync(editorLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as ExecEvent)
      : [];
  const snapshot = (allowed = new Set<string>()) => ({
    workspace: inventory(workspace, allowed),
    corpus: inventory(memoryBase, allowed),
    userContext: Object.fromEntries(
      names.map((name) => {
        const file = path.join(home, name);
        return [
          name,
          allowed.has(file)
            ? 'AUTHORIZED_TARGET'
            : fs.existsSync(file)
              ? fs.readFileSync(file, 'base64')
              : null,
        ];
      }),
    ),
  });
  let baseline: ReturnType<typeof snapshot> | undefined;
  const phases: Array<Record<string, unknown>> = [];
  const frames: Record<string, string> = {},
    panels: Record<string, string> = {};
  const inputs: Array<{ session: number; value: string }> = [],
    exits: Array<{ beforeCleanup: unknown; afterCleanup: unknown }> = [];
  const cleanupErrors: string[] = [];
  const server = await startFakeOpenAIServer(() => ({
    content: 'UNEXPECTED_MEMORY_MODEL_REQUEST',
  }));
  let session: InteractiveSession | undefined,
    number = 0,
    failure: unknown;
  const zero = () =>
    assert.equal(
      server.requests.length,
      0,
      'memory UI must not submit a model request',
    );
  const guard = (label: string, allowed: string[] = []) => {
    zero();
    for (const row of fixed)
      assert.equal(fs.readFileSync(row.file, 'base64'), row.raw);
    assert(baseline);
    const current = snapshot(new Set(allowed));
    const expected = structuredClone(baseline);
    for (const file of allowed) {
      const relativeWorkspace = path.relative(workspace, file),
        relativeCorpus = path.relative(memoryBase, file);
      if (
        relativeWorkspace &&
        !relativeWorkspace.startsWith('..') &&
        !path.isAbsolute(relativeWorkspace)
      )
        delete expected.workspace[relativeWorkspace];
      if (
        relativeCorpus &&
        !relativeCorpus.startsWith('..') &&
        !path.isAbsolute(relativeCorpus)
      )
        delete expected.corpus[relativeCorpus];
      if (path.dirname(file) === home && names.includes(path.basename(file)))
        expected.userContext[path.basename(file)] = 'AUTHORIZED_TARGET';
    }
    assert.deepEqual(current, expected, label);
    phases.push({
      label,
      allowed,
      snapshot: snapshot(),
      workspaceSettings: json(workspaceSettings),
    });
  };
  const until = async (
    check: () => Promise<boolean> | boolean,
    label: string,
  ) => {
    const deadline = performance.now() + 12000;
    while (!(await check())) {
      assert(performance.now() < deadline, label);
      await new Promise((done) => setTimeout(done, 100));
    }
  };
  const panel = (label: string, check: (body: string) => boolean) =>
    until(async () => {
      const frame = await session!.viewport();
      frames[label] = frame;
      zero();
      const body = memoryPanel(frame);
      panels[label] = body;
      return body !== '' && check(body);
    }, label);
  const composer = (label: string) =>
    until(async () => {
      const frame = await session!.viewport();
      frames[label] = frame;
      zero();
      return (
        composerRegion(frame)?.trimStart().startsWith('Type your message') ===
        true
      );
    }, label);
  const press = async (value: string) => {
    await session!.idle(150, 500);
    inputs.push({ session: number, value });
    session!.pressKey(value);
    await session!.idle(150, 500);
    zero();
  };
  const type = async (value: string) => {
    await session!.idle(150, 500);
    for (const point of value) {
      inputs.push({ session: number, value: point });
      session!.pressKey(point);
      await new Promise((done) => setTimeout(done, 8));
    }
    await session!.idle(150, 500);
    zero();
  };
  const waitEvents = (count: number) =>
    until(
      () => events().length === count,
      'actual owned external executable invocation',
    );
  const open = async (label: string) => {
    await type('/memory');
    await press('\r');
    await panel(label, () => true);
  };
  const launch = async () => {
    number++;
    save(`before-launch-${number}.json`, {
      snapshot: snapshot(),
      workspaceSettings: json(workspaceSettings),
    });
    session = await InteractiveSession.start({
      command: {
        bin: command.bin,
        args: [
          ...command.args,
          '--auth-type',
          'openai',
          '--openai-api-key',
          'fixture',
          '--openai-base-url',
          server.baseUrl,
          '--model',
          'qwen-vl-baseline',
          '--approval-mode',
          'default',
        ],
      },
      cwd: workspace,
      cols: 120,
      rows: 40,
      inheritEnv: false,
      env: {
        PATH: bin + ':' + process.env['PATH'],
        HOME: home,
        USERPROFILE: home,
        QWEN_HOME: home,
        QWEN_RUNTIME_DIR: runtime,
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        QWEN_CODE_MEMORY_BASE_DIR: memoryBase,
        QWEN_CODE_TRUSTED_FOLDERS_PATH: trust,
        QWEN_CODE_SYSTEM_SETTINGS_PATH: system,
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaults,
        QWEN_OWNED_MEMORY_EXEC_LOG: editorLog,
        QWEN_OWNED_MEMORY_ALLOWED_TARGETS: JSON.stringify([
          ...allowedTargets,
          userMemory,
          projectMemory,
        ]),
        QWEN_OWNED_MEMORY_EDITOR_FAILURE: group === 'D' ? '1' : '0',
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        QWEN_CODE_LANG: 'en',
        QWEN_SANDBOX: 'false',
        QWEN_CODE_DISABLE_CRON: '1',
        QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
        QWEN_CODE_MODELS_DEV_REFRESH: 'off',
        QWEN_CODE_FORCE_FILE_STORAGE: 'true',
        NO_PROXY: 'localhost,127.0.0.1',
        no_proxy: 'localhost,127.0.0.1',
      },
      onStartupFailure: (raw) =>
        fs.writeFileSync(path.join(output, `startup-${number}.ansi`), raw),
    });
    await composer(`ready-${number}`);
    if (!baseline) baseline = snapshot();
    save(`after-launch-${number}.json`, {
      snapshot: snapshot(),
      workspaceSettings: json(workspaceSettings),
    });
    zero();
    for (const row of fixed)
      assert.equal(fs.readFileSync(row.file, 'base64'), row.raw);
  };
  const quit = async () => {
    await type('/quit');
    await press('\r');
    await until(
      () => session!.exitResult() !== undefined,
      'public natural quit',
    );
    assert.equal(session!.exitResult()!.exitCode, 0);
    assert.equal(session!.exitResult()!.signal ?? 0, 0);
    const beforeCleanup = session!.exitResult();
    fs.writeFileSync(
      path.join(output, `terminal-${number}.ansi`),
      session!.output(),
    );
    await session!.close();
    exits.push({ beforeCleanup, afterCleanup: session!.exitResult() });
    session = undefined;
    zero();
  };
  try {
    save('LAUNCH.json', {
      group,
      profile,
      command,
      workspace,
      home,
      memoryBase,
      userMemory,
      projectMemory,
      stateRoot,
      allowedTargets,
      budgets: { conditionSeconds: 12, testSeconds: 120, retry: 0 },
      coverage:
        'Full public group; owner replacement and actual writer failure require separately scoped source/component evidence.',
    });
    await run({
      workspace,
      home,
      memoryBase,
      userMemory,
      projectMemory,
      stateRoot,
      workspaceSettings,
      legacyUser,
      legacyProject,
      editorLog,
      json,
      launch,
      quit,
      open,
      press,
      panel,
      composer,
      events,
      waitEvents,
      guard,
      save,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (session) {
      const beforeCleanup = session.exitResult() ?? null;
      try {
        frames.failure = await session.viewport();
        fs.writeFileSync(
          path.join(output, `terminal-${number}-before-cleanup.ansi`),
          session.output(),
        );
      } catch (error) {
        cleanupErrors.push('capture: ' + String(error));
      }
      try {
        await session.close();
      } catch (error) {
        cleanupErrors.push('close: ' + String(error));
      }
      exits.push({ beforeCleanup, afterCleanup: session.exitResult() ?? null });
    }
    try {
      fs.cpSync(runtime, path.join(output, 'raw-runtime'), { recursive: true });
      save('final-stores.json', {
        snapshot: snapshot(),
        workspaceSettings: json(workspaceSettings),
      });
    } catch (error) {
      cleanupErrors.push('raw stores: ' + String(error));
    }
    try {
      await server.close();
      zero();
    } catch (error) {
      cleanupErrors.push('server/late model: ' + String(error));
    }
    save('frames.json', frames);
    save('panels.json', panels);
    save('inputs.json', inputs);
    save('exits.json', exits);
    save('phases.json', phases);
    save('requests.json', server.requests);
    save('external-events.json', events());
    save('RESULT.json', {
      result: failure
        ? 'FAIL'
        : cleanupErrors.length
          ? 'EVIDENCE_ERROR'
          : 'PASS',
      group,
      profile,
      command,
      firstError:
        failure instanceof Error
          ? (failure.stack ?? failure.message)
          : failure
            ? String(failure)
            : null,
      cleanupErrors,
      exits,
      modelHTTP: server.requests.length,
      limits: [
        'External executables are real owned fixtures, not real desktop GUI acceptance.',
        'Owner/ABA and actual settings-writer failures are not injected through private APIs in this public case.',
        'No prior/global/partial group pass is full candidate migration acceptance.',
      ],
    });
  }
  if (failure) throw failure;
  assert.deepEqual(cleanupErrors, []);
}

it(
  `Memory A: all four toggles including confirmation, hot/cold Workspace persistence (${profile})`,
  { timeout: 120000, retry: 0 },
  async () => {
    await fixture('A', initialMemory, async (c) => {
      await c.launch();
      const original = c.json(c.workspaceSettings);
      const beforeBytes = fs.readFileSync(c.workspaceSettings);
      await c.open('A-cancel-open');
      await c.press('\x1b');
      await c.composer('A-cancelled');
      assert.deepEqual(fs.readFileSync(c.workspaceSettings), beforeBytes);
      c.guard('A-no-write-cancel');
      let expected = structuredClone(original);
      for (const round of ['hot', 'cold'] as const) {
        await c.open(`A-${round}-open`);
        const expectedMemory = expected['memory'] as Record<string, boolean>;
        await c.panel(`A-${round}-initial-values`, (body) =>
          toggleKeys.every((key, index) =>
            body.includes(
              `${toggleLabels[index]}: ${expectedMemory[key] ? 'on' : 'off'}`,
            ),
          ),
        );
        for (let index = 0; index < toggleKeys.length; index++) {
          await c.press('\x1b[A');
          await c.press('\r');
          const key = toggleKeys[index];
          expected = {
            ...expected,
            memory: {
              ...(expected['memory'] as Record<string, boolean>),
              [key]: !(expected['memory'] as Record<string, boolean>)[key],
            },
          };
          const value = (expected['memory'] as Record<string, boolean>)[key];
          await c.panel(`A-${round}-${key}`, (body) =>
            body.includes(`${toggleLabels[index]}: ${value ? 'on' : 'off'}`),
          );
          assert.deepEqual(c.json(c.workspaceSettings), expected);
          c.guard(`A-${round}-${key}`, [c.workspaceSettings]);
        }
        await c.press('\x1b');
        await c.composer(`A-${round}-closed`);
        await c.open(`A-${round}-reopened`);
        await c.panel(`A-${round}-merged-not-stale-config`, (body) =>
          toggleKeys.every((key, index) =>
            body.includes(
              `${toggleLabels[index]}: ${(expected['memory'] as Record<string, boolean>)[key] ? 'on' : 'off'}`,
            ),
          ),
        );
        await c.press('\x1b');
        await c.composer(`A-${round}-before-quit`);
        await c.quit();
        c.guard(`A-${round}-after-quit`, [c.workspaceSettings]);
        if (round === 'hot') await c.launch();
      }
      assert.deepEqual(c.json(c.workspaceSettings), original);
      assert.equal(c.events().length, 0);
    });
  },
);

it(
  `Memory B: actual preferred User context and newly created Project file editor actions (${profile})`,
  { timeout: 120000, retry: 0 },
  async () => {
    await fixture(
      'B',
      { ...initialMemory, enableManagedAutoMemory: false },
      async (c) => {
        await c.launch();
        assert(!fs.existsSync(c.legacyProject));
        assert(!fs.existsSync(path.join(c.home, names[0])));
        await c.open('B-user-target');
        await c.press('\r');
        await c.composer('B-user-editor-return');
        assert.deepEqual(
          c.events().map((event) => ({ kind: event.kind, argv: event.argv })),
          [{ kind: 'vim', argv: [c.legacyUser] }],
        );
        assert.equal(
          fs.readFileSync(c.legacyUser, 'utf8'),
          'USER_CONTEXT_BEFORE\n' + editMarker,
        );
        assert(!fs.existsSync(c.legacyProject));
        c.guard('B-user-only-change', [c.legacyUser]);
        await c.open('B-project-target');
        await c.press('\x1b[B');
        await c.press('\r');
        await c.composer('B-project-editor-return');
        assert.deepEqual(
          c.events().map((event) => ({ kind: event.kind, argv: event.argv })),
          [
            { kind: 'vim', argv: [c.legacyUser] },
            { kind: 'vim', argv: [c.legacyProject] },
          ],
        );
        assert.equal(fs.readFileSync(c.legacyProject, 'utf8'), editMarker);
        assert(!fs.existsSync(path.join(c.home, names[0])));
        c.guard('B-exact-file-effects', [c.legacyUser, c.legacyProject]);
        await c.quit();
        c.guard('B-final', [c.legacyUser, c.legacyProject]);
      },
    );
  },
);

it(
  `Memory C: actual managed User/Project roots, dream metadata and platform opener/headless index (${profile})`,
  { timeout: 120000, retry: 0 },
  async () => {
    await fixture('C', initialMemory, async (c) => {
      await c.launch();
      const userExisted = fs.existsSync(c.userMemory);
      const userIndex = path.join(c.userMemory, AUTO_MEMORY_INDEX_FILENAME),
        projectIndex = path.join(c.projectMemory, AUTO_MEMORY_INDEX_FILENAME);
      const desktop =
        process.platform === 'darwin' || process.platform === 'win32';
      await c.open('C-managed-user');
      await c.panel(
        'C-metadata-and-folder-kind',
        (body) =>
          !body.includes(names[0]) &&
          body.includes('Auto-dream: off') &&
          body.includes('/dream to run') &&
          !body.includes('· never ·'),
      );
      await c.press('\r');
      await c.composer('C-user-open-return');
      await c.waitEvents(1);
      const userAllowed = [
        ...(userExisted ? [] : [c.userMemory]),
        ...(desktop ? [] : [userIndex]),
      ];
      c.guard('C-user-only-effect', userAllowed);
      await c.open('C-managed-project');
      await c.press('2');
      await c.composer('C-project-open-return');
      await c.waitEvents(2);
      const expected = desktop
        ? [
            { kind: 'open', argv: [c.userMemory] },
            { kind: 'open', argv: [c.projectMemory] },
          ]
        : [
            { kind: 'vim', argv: [userIndex] },
            { kind: 'vim', argv: [projectIndex] },
          ];
      assert.deepEqual(
        c.events().map((event) => ({ kind: event.kind, argv: event.argv })),
        expected,
      );
      assert(fs.statSync(c.userMemory).isDirectory());
      assert(fs.statSync(c.projectMemory).isDirectory());
      if (!desktop) {
        assert.equal(fs.readFileSync(userIndex, 'utf8'), editMarker);
        assert.equal(fs.readFileSync(projectIndex, 'utf8'), editMarker);
      }
      c.guard('C-exact-managed-effects', [
        ...userAllowed,
        ...(desktop ? [] : [projectIndex]),
      ]);
      await c.quit();
      c.guard('C-final', [...userAllowed, ...(desktop ? [] : [projectIndex])]);
    });
  },
);

it(
  `Memory D: actual editor exit7 retains error and usable panel without claiming rollback (${profile})`,
  { timeout: 120000, retry: 0 },
  async () => {
    await fixture(
      'D',
      { ...initialMemory, enableManagedAutoMemory: false },
      async (c) => {
        await c.launch();
        await c.open('D-before-editor-failure');
        await c.press('\r');
        await c.panel('D-visible-editor-error', (body) =>
          body.includes('Editor exited with status 7'),
        );
        assert.deepEqual(
          c.events().map((event) => ({ kind: event.kind, argv: event.argv })),
          [{ kind: 'vim', argv: [c.legacyUser] }],
        );
        assert.equal(
          fs.readFileSync(c.legacyUser, 'utf8'),
          'USER_CONTEXT_BEFORE\n',
        );
        c.guard('D-failed-editor-no-write');
        await c.press('\x1b');
        await c.composer('D-error-cancelled');
        await c.quit();
        c.guard('D-final');
      },
    );
  },
);
