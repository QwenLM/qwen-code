import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { it } from 'vitest';
import { InteractiveSession } from './interactive-session.js';
import { fakeToolCall, startFakeOpenAIServer } from '../fake-openai-server.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';

const root = path.resolve(import.meta.dirname, '../..');
const renderer = pickE2eRenderer();
const override = process.env['QWEN_SKILL_REVIEW_COMMAND_JSON'];
const command = override
  ? (JSON.parse(override) as { bin: string; args: string[] })
  : {
      bin: resolveE2eCliCommand(renderer),
      args: [path.join(root, 'dist/cli.js')],
    };
assert(
  typeof command.bin === 'string' &&
    Array.isArray(command.args) &&
    command.args.every((arg: unknown) => typeof arg === 'string'),
);
if (override) assert(path.isAbsolute(command.bin));
const outputRoot = process.env['QWEN_TUI_ACCEPTANCE_OUT'];
assert(outputRoot && path.isAbsolute(outputRoot));
const editedMarker = '\nOWNED_EDITOR_STAGE_PROOF\n';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function tree(root: string): Record<string, unknown> {
  const rows: Record<string, unknown> = {};
  const visit = (file: string) => {
    const stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), 'owned fixture must contain no symlink');
    const relative = path.relative(root, file) || '.';
    if (stat.isDirectory()) {
      rows[relative] = { type: 'dir', mode: stat.mode & 0o7777 };
      for (const name of fs.readdirSync(file).sort())
        visit(path.join(file, name));
    } else {
      assert(stat.isFile());
      const bytes = fs.readFileSync(file);
      rows[relative] = {
        type: 'file',
        mode: stat.mode & 0o7777,
        sha256: sha(bytes),
        bytes: bytes.length,
        base64: bytes.toString('base64'),
      };
    }
  };
  if (fs.existsSync(root)) visit(root);
  return rows;
}
function panel(viewport: string, caption: string): string {
  const lines = viewport.split('\n'),
    found: string[] = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[╭┌]─{4,}.*[╮┐]\s*$/.test(lines[i])) start = i;
    if (start >= 0 && /^\s*[╰└]─{4,}.*[╯┘]\s*$/.test(lines[i])) {
      const body = lines.slice(start, i + 1).join('\n');
      if (body.includes(caption)) found.push(body);
      start = -1;
    }
  }
  return found.length === 1 ? found[0] : '';
}
function reviewPanel(viewport: string): string {
  const body = panel(viewport, 'Auto-generated skill');
  return body.includes('Keep this skill') && body.includes('Discard this skill')
    ? body
    : '';
}
function composerRegion(viewport: string): string | null {
  const lines = viewport.split('\n');
  const borders = lines.flatMap((line, index) =>
    /^\s*─{8,}/.test(line) ? [index] : [],
  );
  const regions: string[] = [];
  for (let i = 0; i + 1 < borders.length; i++) {
    const body = lines.slice(borders[i] + 1, borders[i + 1]);
    if (body.length === 1 && /^\s*> /.test(body[0]))
      regions.push(body[0].replace(/^\s*> /, '').trimEnd());
  }
  return regions.length === 1 ? regions[0] : null;
}
function emptyComposer(viewport: string): boolean {
  return (
    composerRegion(viewport)?.trimStart() ===
    'Type your message or @path/to/file'
  );
}
type Group = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';
type Batch = {
  trigger: string;
  names: string[];
  contents: string[];
  readPaths: string[];
  readIds: string[];
  writeIds: string[];
  mainCalls: number;
  workerCalls: number;
};
type ExternalEvent = {
  kind: string;
  argv: string[];
  cwd: string;
  pid: number;
  ppid: number;
};

async function fixture(
  group: Group,
  run: (c: {
    batches: Batch[];
    generate: (index?: number) => Promise<void>;
    review: (
      label: string,
      batch: Batch,
      index: number,
      extra?: string,
    ) => Promise<void>;
    press: (input: string) => Promise<void>;
    composer: (label: string) => Promise<void>;
    memory: (
      label: string,
      state: 'on' | 'off',
      open?: boolean,
    ) => Promise<void>;
    wait: (check: () => boolean, label: string) => Promise<void>;
    stage: (name: string) => string;
    live: (name: string) => string;
    guard: (label: string) => void;
    resolved: (batch: Batch, kept: number[], edited?: boolean) => Promise<void>;
    stagesUnchanged: (batch: Batch) => void;
    events: () => ExternalEvent[];
    exactWorkspace: (enabled?: boolean) => void;
    output: string;
    queueRegression: () => Promise<void>;
  }) => Promise<void>,
) {
  fs.mkdirSync(outputRoot!, { recursive: true });
  const output = fs.realpathSync(
    fs.mkdtempSync(path.join(outputRoot!, `skill-review-${group}-`)),
  );
  const save = (name: string, value: unknown) =>
    fs.writeFileSync(
      path.join(output, name),
      JSON.stringify(value, null, 2) + '\n',
    );
  const home = path.join(output, 'home'),
    workspace = path.join(output, 'workspace'),
    runtime = path.join(output, 'runtime'),
    temp = path.join(output, 'tmp'),
    bin = path.join(output, 'bin');
  for (const dir of [home, workspace, runtime, temp, bin]) fs.mkdirSync(dir);
  const qwen = path.join(workspace, '.qwen'),
    skills = path.join(qwen, 'skills'),
    pending = path.join(qwen, 'pending-skills'),
    fixtures = path.join(workspace, 'owned-read-fixtures');
  fs.mkdirSync(path.join(skills, 'owned-user-sentinel'), { recursive: true });
  fs.mkdirSync(fixtures);
  const sentinel = path.join(skills, 'owned-user-sentinel/SKILL.md');
  fs.writeFileSync(
    sentinel,
    '---\nname: owned-user-sentinel\ndescription: Immutable user-authored sentinel\n---\nOWNED_USER_SKILL_UNCHANGED\n',
  );
  const readPaths = Array.from(
    { length: group === 'E' ? 2 : 1 },
    (_, batchIndex) =>
      Array.from({ length: 20 }, (_, i) =>
        path.join(
          fixtures,
          batchIndex === 0
            ? `read-${i + 1}.txt`
            : `read-batch-${batchIndex + 1}-${i + 1}.txt`,
        ),
      ),
  );
  readPaths.forEach((paths) =>
    paths.forEach((file, i) =>
      fs.writeFileSync(file, `OWNED_REVIEW_READ_${i + 1}\n`),
    ),
  );
  const user = path.join(home, 'settings.json'),
    settings = path.join(qwen, 'settings.json'),
    trust = path.join(home, 'trustedFolders.json');
  const originalSettings = { $version: 4, ui: { hideTips: true } };
  const writeJSON = (file: string, value: unknown) =>
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  writeJSON(user, {
    $version: 4,
    security: {
      auth: { selectedType: 'openai' },
      folderTrust: { enabled: true },
    },
    general: {
      preferredEditor: 'vim',
      enableAutoUpdate: false,
      showSessionRecap: false,
    },
    ui: { hideTips: true, enableFollowupSuggestions: false },
    experimental: { mods: false },
    memory: {
      ...E2E_MEMORY_SETTINGS_DEFAULTS,
      enableAutoSkill: group !== 'G',
      autoSkillConfirm: true,
    },
  });
  writeJSON(settings, originalSettings);
  writeJSON(trust, { [workspace]: 'TRUST_FOLDER' });
  for (const name of ['system.json', 'defaults.json'])
    save(name, { $version: 4 });
  const fixed = [
    user,
    trust,
    sentinel,
    path.join(output, 'system.json'),
    path.join(output, 'defaults.json'),
  ];
  const immutable = () => ({
    files: Object.fromEntries(
      fixed.map((file) => {
        const stat = fs.lstatSync(file);
        assert(stat.isFile() && !stat.isSymbolicLink());
        const bytes = fs.readFileSync(file);
        return [
          file,
          {
            type: 'file',
            mode: stat.mode & 0o7777,
            bytes: bytes.length,
            sha256: sha(bytes),
            base64: bytes.toString('base64'),
          },
        ];
      }),
    ),
    reads: tree(fixtures),
  });
  const before = immutable(),
    initialSettingsBytes = fs.readFileSync(settings);
  const batches: Batch[] = Array.from(
    { length: group === 'E' ? 2 : 1 },
    (_, index) => {
      const names = Array.from(
        { length: group === 'B' || group === 'C' ? 3 : 2 },
        (_, n) =>
          `auto-skill-owned-${group.toLowerCase()}-${index + 1}-${n + 1}`,
      );
      return {
        trigger: `OWNED_SKILL_REVIEW_TRIGGER_${group}_${index + 1}`,
        names,
        contents: names.map(
          (_, n) =>
            `---\nname: owned-review-${group.toLowerCase()}-${index + 1}-${n + 1}\ndescription: Owned generated review ${n + 1}\nsource: auto-skill\n---\n\nOWNED_GENERATED_REVIEW_BODY_${index + 1}_${n + 1}\n`,
        ),
        readPaths: readPaths[index],
        readIds: readPaths[index].map(
          (_, n) => `owned_read_${group}_${index}_${n}`,
        ),
        writeIds: names.map((_, n) => `owned_write_${group}_${index}_${n}`),
        mainCalls: 0,
        workerCalls: 0,
      };
    },
  );
  const live = (name: string) => path.join(skills, name, 'SKILL.md');
  assert(!fs.existsSync(pending));
  const editorLog = path.join(output, 'external-events.jsonl');
  // This executable is an owned real editor fixture. It validates the actual
  // manager-created stage path, edits alpha, and independently exits7 for beta.
  const editor = `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),root=process.env.QWEN_OWNED_REVIEW_PENDING;fs.appendFileSync(process.env.QWEN_OWNED_REVIEW_EXEC_LOG,JSON.stringify({kind:'vim',argv:args,cwd:process.cwd(),pid:process.pid,ppid:process.ppid})+String.fromCharCode(10));if(args.length!==1)process.exit(91);const real=fs.realpathSync(args[0]),parts=path.relative(root,real).split(path.sep);if(parts.length!==3||parts[0]==='..'||!JSON.parse(process.env.QWEN_OWNED_REVIEW_NAMES).includes(parts[1])||parts[2]!=='SKILL.md')process.exit(92);if(parts[1].endsWith('-2'))process.exit(7);fs.appendFileSync(real,${JSON.stringify(editedMarker)});process.exit(0);\n`;
  fs.writeFileSync(path.join(bin, 'vim'), editor, { mode: 0o755 });
  const events = (): ExternalEvent[] =>
    fs.existsSync(editorLog)
      ? fs
          .readFileSync(editorLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as ExternalEvent)
      : [];
  const routes: string[] = [],
    routerErrors: string[] = [];
  const queued2 = 'OWNED_SKILL_REVIEW_H_AUX2',
    queued3 = 'OWNED_SKILL_REVIEW_H_AUX3';
  let releaseWorker!: () => void, releaseAux2!: () => void;
  const workerHeld = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  const aux2Held = new Promise<void>((resolve) => {
    releaseAux2 = resolve;
  });
  let workerCompleteWaiting = false,
    aux2Calls = 0,
    aux3Calls = 0,
    decisionSent = false;
  const expectedHTTP = () =>
    group === 'G' ? 2 : batches.length * 4 + (group === 'H' ? 2 : 0);
  const server = await startFakeOpenAIServer(({ body }) => {
    try {
      assert(Array.isArray(body['messages']));
      const messages = body['messages'] as Array<{
        role?: string;
        content?: unknown;
        tool_call_id?: string;
      }>;
      const serialized = JSON.stringify(messages),
        system = JSON.stringify(messages.filter((m) => m.role === 'system'));
      const latestUser = messages.findLast(
        (message) => message.role === 'user',
      );
      const userText = JSON.stringify(latestUser?.content ?? '');
      const isWorker = system.includes(
        'You are reviewing this conversation to extract reusable skills.',
      );
      if (
        group === 'H' &&
        !isWorker &&
        (userText.includes(queued2) || userText.includes(queued3))
      ) {
        assert(
          !(userText.includes(queued2) && userText.includes(queued3)),
          'queued messages must not merge into one request',
        );
        assert.equal(
          messages.filter(
            (message) =>
              message.role === 'tool' &&
              /owned_read_H_/.test(message.tool_call_id ?? ''),
          ).length,
          20,
        );
        if (userText.includes(queued2)) {
          aux2Calls++;
          assert.equal(aux2Calls, 1, 'one real second-user request');
          assert(
            workerCompleteWaiting,
            'worker final response must be held before aux2 begins',
          );
          assert(
            !fs.existsSync(pending),
            'pending stage must not exist before aux2 starts',
          );
          routes.push('H:aux2-request-start');
          releaseWorker();
          return {
            contentChunks: [
              'OWNED_H_AUX2_STREAM_STARTED',
              '_OWNED_H_AUX2_COMPLETE',
            ],
            holdAfterChunks: 1,
            holdUntil: aux2Held,
          };
        }
        aux3Calls++;
        assert.equal(aux3Calls, 1, 'one real queued third-user request');
        assert(
          decisionSent,
          'queued user3 must not run before the explicit review decision',
        );
        for (const name of batches[0].names) {
          assert(
            !fs.existsSync(live(name)),
            'H discards must not promote generated skills',
          );
          assert(
            !fs.existsSync(observedStages.get(name)!),
            'queued user3 must wait until actual pending skills are resolved',
          );
        }
        routes.push('H:aux3-request-after-decision');
        return { content: 'OWNED_H_AUX3_COMPLETE' };
      }
      const batch = batches
        .filter((candidate) => serialized.includes(candidate.trigger))
        .at(-1);
      assert(batch, 'request must identify an actual declared public prompt');
      const tools = messages.filter((m) => m.role === 'tool');
      if (isWorker) {
        assert(group !== 'G', 'disabled policy must not start a worker');
        batch.workerCalls++;
        assert(batch.workerCalls <= 2, 'unexpected worker request/retry');
        assert(serialized.includes('Project skills directory:'));
        const results = tools.filter((m) =>
          batch.writeIds.includes(m.tool_call_id ?? ''),
        );
        if (results.length === 0) {
          assert.equal(batch.workerCalls, 1);
          routes.push(batch.trigger + ':worker-writes');
          return {
            toolCalls: batch.names.map((name, i) =>
              fakeToolCall(
                'write_file',
                { file_path: live(name), content: batch.contents[i] },
                batch.writeIds[i],
              ),
            ),
          };
        }
        assert.equal(batch.workerCalls, 2);
        assert.deepEqual(
          results.map((m) => m.tool_call_id).sort(),
          [...batch.writeIds].sort(),
        );
        routes.push(batch.trigger + ':worker-complete');
        if (group === 'H') {
          workerCompleteWaiting = true;
          return workerHeld.then(() => ({
            content: 'Created the declared owned reusable skills.',
          }));
        }
        return { content: 'Created the declared owned reusable skills.' };
      }
      batch.mainCalls++;
      assert(batch.mainCalls <= 2, 'unexpected main request/retry');
      const results = tools.filter((m) =>
        batch.readIds.includes(m.tool_call_id ?? ''),
      );
      if (batch.mainCalls === 1) {
        assert.equal(results.length, 0);
        routes.push(batch.trigger + ':twenty-reads');
        return {
          toolCalls: batch.readPaths.map((file, i) =>
            fakeToolCall('read_file', { file_path: file }, batch.readIds[i]),
          ),
        };
      }
      assert.deepEqual(
        results.map((m) => m.tool_call_id).sort(),
        [...batch.readIds].sort(),
      );
      batch.readPaths.forEach((_, i) =>
        assert(
          JSON.stringify(
            results.find((m) => m.tool_call_id === batch.readIds[i]),
          ).includes(`OWNED_REVIEW_READ_${i + 1}`),
        ),
      );
      routes.push(batch.trigger + ':main-complete');
      return { content: batch.trigger + '_MAIN_COMPLETE' };
    } catch (error) {
      routerErrors.push(String(error));
      throw error;
    }
  });
  const frames: Record<string, string> = {},
    panels: Record<string, string> = {},
    inputs: string[] = [],
    phases: unknown[] = [];
  const observedStages = new Map<string, string>();
  let session: InteractiveSession | undefined,
    failure: unknown,
    beforeCleanup: unknown = null;
  const cleanupErrors: string[] = [];
  const until = async (
    check: () => Promise<boolean> | boolean,
    label: string,
  ) => {
    const deadline = performance.now() + 12000;
    while (!(await check())) {
      assert(performance.now() < deadline, label);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const capture = async (label: string) => {
    frames[label] = await session!.viewport();
    return frames[label];
  };
  const press = async (input: string) => {
    await session!.idle(150, 500);
    inputs.push(input);
    session!.pressKey(input);
    await session!.idle(150, 500);
  };
  const type = async (input: string) => {
    await session!.idle(150, 500);
    inputs.push(input);
    for (const point of input) {
      session!.pressKey(point);
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    await session!.idle(150, 500);
  };
  let expectedWorkspaceEnabled: boolean | undefined;
  const expectedWorkspace = () =>
    expectedWorkspaceEnabled === undefined
      ? originalSettings
      : {
          ...originalSettings,
          memory: { enableAutoSkill: expectedWorkspaceEnabled },
        };
  const exactWorkspace = (enabled?: boolean) => {
    const expected =
      enabled === undefined
        ? originalSettings
        : { ...originalSettings, memory: { enableAutoSkill: enabled } };
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), expected);
    expectedWorkspaceEnabled = enabled;
  };
  const guard = (label: string) => {
    assert.deepEqual(immutable(), before);
    assert.deepEqual(routerErrors, []);
    if (group !== 'F')
      assert.deepEqual(fs.readFileSync(settings), initialSettingsBytes);
    else
      assert.deepEqual(
        JSON.parse(fs.readFileSync(settings, 'utf8')),
        expectedWorkspace(),
      );
    const known = new Set(batches.flatMap((batch) => batch.names));
    for (const dir of fs.readdirSync(skills)) {
      assert(
        dir === 'owned-user-sentinel' || known.has(dir),
        'unexpected live skill',
      );
      assert(
        fs.lstatSync(path.join(skills, dir)).isDirectory(),
        'live skill must be a directory',
      );
    }
    for (const file of Object.keys(tree(skills)))
      if (
        file !== '.' &&
        file !== 'owned-user-sentinel' &&
        file !== 'owned-user-sentinel/SKILL.md'
      )
        assert(
          known.has(file) ||
            [...known].some((name) => file === name + '/SKILL.md'),
          'unexpected live child',
        );
    const taskIds = new Set(
      [...observedStages.values()].map((file) =>
        path.basename(path.dirname(path.dirname(file))),
      ),
    );
    for (const [file, value] of Object.entries(tree(pending))) {
      if (file === '.') continue;
      const parts = file.split(path.sep);
      assert(taskIds.has(parts[0]), 'unexpected pending task');
      assert(
        parts.length <= 3 &&
          (parts.length < 2 || known.has(parts[1])) &&
          (parts.length < 3 || parts[2] === 'SKILL.md'),
        'unexpected pending child',
      );
      if (parts.length < 3)
        assert.equal((value as { type: string }).type, 'dir');
    }
    phases.push({
      label,
      immutable: immutable(),
      workspaceSettings: JSON.parse(fs.readFileSync(settings, 'utf8')),
      skills: tree(skills),
      pending: tree(pending),
    });
  };
  const stage = (name: string) => {
    const matches = fs.existsSync(pending)
      ? fs
          .readdirSync(pending)
          .map((task) => path.join(pending, task, name, 'SKILL.md'))
          .filter((file) => fs.existsSync(file))
      : [];
    assert.equal(
      matches.length,
      1,
      'one real manager task per generated stage',
    );
    observedStages.set(name, matches[0]);
    return matches[0];
  };
  const stagesUnchanged = (batch: Batch) =>
    batch.names.forEach((name, i) => {
      assert.equal(fs.readFileSync(stage(name), 'utf8'), batch.contents[i]);
      assert(!fs.existsSync(live(name)));
    });
  const review = async (
    label: string,
    batch: Batch,
    index: number,
    extra = `OWNED_GENERATED_REVIEW_BODY_${batches.indexOf(batch) + 1}_${index + 1}`,
  ) => {
    await until(async () => {
      const body = reviewPanel(await capture(label));
      panels[label] = body;
      return (
        body.includes(`${index + 1}/${batch.names.length}`) &&
        body.includes(batch.names[index]) &&
        body.includes(extra)
      );
    }, label);
    const remaining = batch.names.length - index;
    assert.equal(panels[label].includes('Keep all remaining'), remaining > 1);
    assert.equal(
      panels[label].includes('Discard all remaining'),
      remaining > 1,
    );
    assert(panels[label].includes('Turn off auto-generated skills'));
  };
  const composer = async (label: string) =>
    until(
      async () =>
        emptyComposer(await capture(label)) && !reviewPanel(frames[label]),
      label,
    );
  const memory = async (label: string, state: 'on' | 'off', open = true) => {
    if (open) {
      await type('/memory');
      await press('\r');
    }
    await until(async () => {
      const body = panel(await capture(label), 'Memory');
      panels[label] = body;
      return (
        body.includes('Auto-skill: ' + state) &&
        body.includes('Confirm auto-skills before saving')
      );
    }, label);
  };
  const generate = async (index = 0) => {
    const batch = batches[index];
    await type(
      batch.trigger +
        ' inspect the twenty owned fixtures and finish; preserve every existing file.',
    );
    await press('\r');
    if (group === 'G') {
      await until(
        async () =>
          (await capture('G-main-complete')).includes(
            batch.trigger + '_MAIN_COMPLETE',
          ) && emptyComposer(frames['G-main-complete']),
        'G actual main completion',
      );
      return;
    }
    await review(`generation-${index + 1}-first`, batch, 0);
    assert.equal(batch.mainCalls, 2);
    assert.equal(batch.workerCalls, 2);
    stagesUnchanged(batch);
    const tasks = batch.names.map((name) =>
      path.dirname(path.dirname(stage(name))),
    );
    assert(tasks.every((task) => task === tasks[0]));
    if (index)
      assert.notEqual(
        tasks[0],
        path.dirname(path.dirname(observedStages.get(batches[0].names[0])!)),
        'second genuine generation must have another task',
      );
    guard(`generation-${index + 1}-staged`);
  };
  const resolved = async (batch: Batch, kept: number[], edited = false) => {
    await until(
      () =>
        batch.names.every(
          (name, i) =>
            !fs.existsSync(observedStages.get(name)!) &&
            fs.existsSync(live(name)) === kept.includes(i),
        ),
      'exact real decision effects',
    );
    batch.names.forEach((name, i) => {
      if (kept.includes(i))
        assert.equal(
          fs.readFileSync(live(name), 'utf8'),
          batch.contents[i] + (edited && i === 0 ? editedMarker : ''),
        );
    });
    await composer('decisions-closed-' + batch.trigger);
    guard('decisions-' + batch.trigger);
  };
  const queueRegression = async () => {
    assert.equal(group, 'H');
    const batch = batches[0];
    await type(
      batch.trigger +
        ' inspect the twenty owned fixtures and finish; preserve every existing file.',
    );
    await press('\r');
    await until(
      () => workerCompleteWaiting,
      'H genuine worker final response reaches declared hold',
    );
    assert.equal(batch.mainCalls, 2);
    assert.equal(batch.workerCalls, 2);
    assert(!fs.existsSync(pending), 'worker hold must precede manager staging');
    await type(queued2);
    await press('\r');
    await until(
      async () =>
        aux2Calls === 1 &&
        (await capture('H-aux2-streaming')).includes(
          'OWNED_H_AUX2_STREAM_STARTED',
        ),
      'H aux2 genuinely streams',
    );
    await until(
      () =>
        fs.existsSync(pending) &&
        batch.names.every((name) =>
          fs
            .readdirSync(pending)
            .some((task) =>
              fs.existsSync(path.join(pending, task, name, 'SKILL.md')),
            ),
        ),
      'H actual manager pending files while aux2 stream held',
    );
    stagesUnchanged(batch);
    const tasks = batch.names.map((name) =>
      path.dirname(path.dirname(stage(name))),
    );
    assert(
      tasks.every((task) => task === tasks[0]),
      'one actual H review task',
    );
    guard('H-pending-while-main-busy');
    await type(queued3);
    await press('\x11');
    await until(async () => {
      const view = await capture('H-third-user-genuinely-queued');
      return (
        emptyComposer(view) &&
        view.includes(queued3) &&
        view.includes('Ctrl+Q to queue')
      );
    }, 'H real Ctrl+Q queue row and cleared composer');
    assert.equal(aux3Calls, 0);
    assert.equal(server.requests.length, 5);
    save('QUEUE-BEFORE-RELEASE.json', {
      taskPaths: tasks,
      stages: tree(pending),
      aux2Calls,
      aux3Calls,
      routes: [...routes],
    });
    releaseAux2();
    await review('H-review-before-queue-drain', batch, 0);
    assert.equal(aux3Calls, 0, 'pending review owns UI before queued prompt');
    assert.equal(server.requests.length, 5);
    stagesUnchanged(batch);
    guard('H-review-blocks-queued-user');
    decisionSent = true;
    await press('4');
    await until(
      () =>
        batch.names.every(
          (name) =>
            !fs.existsSync(observedStages.get(name)!) &&
            !fs.existsSync(live(name)),
        ),
      'H explicit Discard all resolves actual pending files',
    );
    await until(
      async () =>
        aux3Calls === 1 &&
        (await capture('H-queued-user-runs-once')).includes(
          'OWNED_H_AUX3_COMPLETE',
        ) &&
        emptyComposer(frames['H-queued-user-runs-once']),
      'H queued user resumes once after review',
    );
    assert.equal(aux2Calls, 1);
    assert.equal(aux3Calls, 1);
    assert.equal(server.requests.length, 6);
    guard('H-queue-preserved-through-review');
  };
  try {
    save('FIXTURE.json', {
      group,
      command,
      renderer,
      workspace,
      home,
      before,
      budgets: {
        caseSeconds: group === 'E' || group === 'H' ? 180 : 120,
        conditionSeconds: 12,
        outerSeconds: group === 'E' || group === 'H' ? 240 : 180,
        retry: 0,
      },
      initiallyPendingAbsent: !fs.existsSync(pending),
      batches,
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
        TMPDIR: temp,
        TMP: temp,
        TEMP: temp,
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        QWEN_CODE_LANG: 'en',
        QWEN_SANDBOX: 'false',
        QWEN_CODE_FORCE_FILE_STORAGE: 'true',
        QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(output, 'system.json'),
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(output, 'defaults.json'),
        QWEN_CODE_TRUSTED_FOLDERS_PATH: trust,
        QWEN_OWNED_REVIEW_PENDING: pending,
        QWEN_OWNED_REVIEW_NAMES: JSON.stringify(
          batches.flatMap((batch) => batch.names),
        ),
        QWEN_OWNED_REVIEW_EXEC_LOG: editorLog,
        QWEN_CODE_DISABLE_CRON: '1',
        QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
        QWEN_CODE_MODELS_DEV_REFRESH: 'off',
        NO_PROXY: 'localhost,127.0.0.1',
        no_proxy: 'localhost,127.0.0.1',
      },
      onStartupFailure: (raw) =>
        fs.writeFileSync(path.join(output, 'startup.ansi'), raw),
    });
    await capture('ready');
    guard('ready');
    await run({
      batches,
      generate,
      review,
      press,
      composer,
      memory,
      wait: until,
      stage,
      live,
      guard,
      resolved,
      stagesUnchanged,
      events,
      exactWorkspace,
      output,
      queueRegression,
    });
    await type('/quit');
    await press('\r');
    await until(
      () => session!.exitResult() !== undefined,
      'public natural quit',
    );
    assert.equal(session.exitResult()!.exitCode, 0);
    assert.equal(session.exitResult()!.signal ?? 0, 0);
    beforeCleanup = session.exitResult();
    batches.forEach((batch) => {
      assert.equal(batch.mainCalls, 2);
      assert.equal(batch.workerCalls, group === 'G' ? 0 : 2);
    });
    assert.equal(server.requests.length, expectedHTTP());
    assert.deepEqual(routerErrors, []);
    if (group !== 'D') assert.equal(events().length, 0);
    guard('final');
  } catch (error) {
    failure = error;
    if (error && typeof error === 'object') {
      const values = error as { actual?: unknown; expected?: unknown };
      save('ASSERTION-VALUES.json', {
        actual: values.actual,
        expected: values.expected,
      });
    }
  } finally {
    releaseWorker();
    releaseAux2(); // Never strand a test-server response on the first failure.
    if (session) {
      beforeCleanup ??= session.exitResult() ?? null;
      fs.writeFileSync(path.join(output, 'terminal.ansi'), session.output());
      try {
        await capture('before-cleanup');
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    }
    try {
      save('RAW-STORES-BEFORE-CLEANUP.json', {
        skills: tree(skills),
        pending: tree(pending),
        protected: immutable(),
        settings: JSON.parse(fs.readFileSync(settings, 'utf8')),
      });
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    if (session)
      try {
        await session.close();
      } catch (error) {
        cleanupErrors.push('close: ' + String(error));
      }
    if (group === 'H')
      try {
        save('RAW-STORES-AFTER-CLEANUP.json', {
          skills: tree(skills),
          pending: tree(pending),
          protected: immutable(),
          settings: JSON.parse(fs.readFileSync(settings, 'utf8')),
        });
      } catch (error) {
        cleanupErrors.push('postcleanup stores: ' + String(error));
      }
    try {
      await server.close();
      if (!failure) {
        assert.equal(server.requests.length, expectedHTTP());
        assert.deepEqual(routerErrors, []);
      }
    } catch (error) {
      cleanupErrors.push('server close: ' + String(error));
    }
    save('frames.json', frames);
    save('panels.json', panels);
    save('inputs.json', inputs);
    save('phases.json', phases);
    save('external-events.json', events());
    save('requests.json', server.requests);
    save('RESULT.json', {
      state: !failure && cleanupErrors.length === 0 ? 'PASS' : 'FAIL',
      group,
      renderer,
      command,
      batches,
      queueWitness:
        group === 'H'
          ? { aux2Calls, aux3Calls, decisionSent, workerCompleteWaiting }
          : undefined,
      modelHTTP: server.requests.length,
      routes,
      routerErrors,
      beforeCleanup,
      afterCleanup: session?.exitResult() ?? null,
      firstError:
        failure instanceof Error
          ? failure.stack
          : failure
            ? String(failure)
            : null,
      cleanupErrors,
    });
  }
  if (failure) throw failure;
  assert.deepEqual(cleanupErrors, []);
}

it(
  'SkillReview A: genuine worker, single Keep then Discard',
  { timeout: 120000, retry: 0 },
  async () =>
    fixture('A', async (c) => {
      await c.generate();
      const batch = c.batches[0],
        staged = batch.names.map(c.stage);
      await c.press('\r');
      await c.review('A-second', batch, 1);
      await c.wait(
        () =>
          fs.existsSync(c.live(batch.names[0])) && !fs.existsSync(staged[0]),
        'alpha promoted',
      );
      assert.equal(
        fs.readFileSync(c.live(batch.names[0]), 'utf8'),
        batch.contents[0],
      );
      assert(!fs.existsSync(c.live(batch.names[1])));
      assert.equal(fs.readFileSync(staged[1], 'utf8'), batch.contents[1]);
      c.guard('A-after-keep');
      await c.press('\x1b[B');
      await c.press('\r');
      await c.resolved(batch, [0]);
    }),
);

it(
  'SkillReview B: Discard first, Keep all remaining',
  { timeout: 120000, retry: 0 },
  async () =>
    fixture('B', async (c) => {
      await c.generate();
      const batch = c.batches[0],
        first = c.stage(batch.names[0]);
      await c.press('2');
      await c.review('B-second', batch, 1);
      await c.wait(() => !fs.existsSync(first), 'first discarded');
      assert(!fs.existsSync(c.live(batch.names[0])));
      c.guard('B-first-discarded');
      await c.press('3');
      await c.resolved(batch, [1, 2]);
    }),
);

it(
  'SkillReview C: Keep first, Discard all remaining',
  { timeout: 120000, retry: 0 },
  async () =>
    fixture('C', async (c) => {
      await c.generate();
      const batch = c.batches[0],
        first = c.stage(batch.names[0]);
      await c.press('\r');
      await c.review('C-second', batch, 1);
      await c.wait(
        () => fs.existsSync(c.live(batch.names[0])) && !fs.existsSync(first),
        'first kept',
      );
      assert.equal(
        fs.readFileSync(c.live(batch.names[0]), 'utf8'),
        batch.contents[0],
      );
      c.guard('C-first-kept');
      await c.press('4');
      await c.resolved(batch, [0]);
    }),
);

it(
  'SkillReview D: real staged-file editor refresh and exit7',
  { timeout: 120000, retry: 0 },
  async () =>
    fixture('D', async (c) => {
      await c.generate();
      const batch = c.batches[0],
        stages = batch.names.map(c.stage);
      await c.press('o');
      await c.review('D-edited-current', batch, 0, 'OWNED_EDITOR_STAGE_PROOF');
      assert.equal(
        fs.readFileSync(stages[0], 'utf8'),
        batch.contents[0] + editedMarker,
      );
      assert(!fs.existsSync(c.live(batch.names[0])));
      assert.equal(c.events().length, 1);
      c.guard('D-edited-stage-not-decided');
      await c.press('\r');
      await c.review('D-second', batch, 1);
      await c.press('o');
      await c.review('D-editor-error', batch, 1, 'Editor exited with status 7');
      assert.equal(fs.readFileSync(stages[1], 'utf8'), batch.contents[1]);
      assert(!fs.existsSync(c.live(batch.names[1])));
      const events = c.events();
      assert.deepEqual(
        events.map((event) => ({
          kind: event.kind,
          argv: event.argv,
          cwd: event.cwd,
        })),
        stages.map((file) => ({
          kind: 'vim',
          argv: [file],
          cwd: path.join(c.output, 'workspace'),
        })),
      );
      events.forEach((event) => {
        assert(event.pid > 0);
        assert(event.ppid > 0);
      });
      c.guard('D-editor-failure-retains-stage');
      await c.press('2');
      await c.resolved(batch, [0], true);
    }),
);

it(
  'SkillReview E: Escape defers one actual task without dismissing its successor',
  { timeout: 180000, retry: 0 },
  async () =>
    fixture('E', async (c) => {
      await c.generate();
      const original = c.batches[0];
      await c.press('\x1b');
      await c.composer('E-deferred-composer');
      c.stagesUnchanged(original);
      c.guard('E-defer-no-write');
      await c.memory('E-memory-no-change', 'on');
      await c.press('\x1b');
      await c.composer('E-no-immediate-reopen');
      c.stagesUnchanged(original);
      c.exactWorkspace();
      await c.generate(1);
      const next = c.batches[1];
      c.stagesUnchanged(original);
      c.guard('E-new-actual-task-old-deferred');
      await c.press('4');
      await c.resolved(next, []);
      c.stagesUnchanged(original);
      c.guard('E-old-task-remains-deferred');
    }),
);

it(
  'SkillReview F: Turn off persists, retains stage, and Memory re-enables review',
  { timeout: 120000, retry: 0 },
  async () =>
    fixture('F', async (c) => {
      await c.generate();
      const batch = c.batches[0];
      await c.press('5');
      await c.composer('F-turned-off');
      c.exactWorkspace(false);
      c.stagesUnchanged(batch);
      c.guard('F-off-no-decision');
      await c.memory('F-memory-off-observed', 'off');
      await c.press('\x1b');
      await c.composer('F-disabled-no-reopen');
      c.stagesUnchanged(batch);
      await c.memory('F-memory-reenable', 'off');
      await c.press('\x1b[A');
      await c.press('\x1b[A');
      await c.press('\r');
      await c.memory('F-memory-now-on', 'on', false);
      c.exactWorkspace(true);
      await c.press('\x1b');
      await c.review('F-same-undismissed-batch', batch, 0);
      c.stagesUnchanged(batch);
      await c.press('4');
      await c.resolved(batch, []);
      c.exactWorkspace(true);
    }),
);

it(
  'SkillReview G: disabled policy does not start a worker or stage skills',
  { timeout: 120000, retry: 0 },
  async () =>
    fixture('G', async (c) => {
      await c.generate();
      const batch = c.batches[0];
      assert.equal(batch.mainCalls, 2);
      assert.equal(batch.workerCalls, 0);
      assert(
        !fs.existsSync(path.join(c.output, 'workspace/.qwen/pending-skills')),
      );
      batch.names.forEach((name) => assert(!fs.existsSync(c.live(name))));
      c.exactWorkspace();
      c.guard('G-disabled-main-completed');
    }),
);

it(
  'SkillReview H: real queued user waits for pending review and resumes once',
  { timeout: 180000, retry: 0 },
  async () =>
    fixture('H', async (c) => {
      await c.queueRegression();
    }),
);
