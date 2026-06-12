/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandLoader } from './loader.js';
import type { AuditEntry, AuditRecorder } from '../auditLog.js';

class FakeAudit implements AuditRecorder {
  entries: AuditEntry[] = [];
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

let root: string;
let userDir: string;
let workspaceCwd: string;
let workspaceDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rc-cmd-'));
  userDir = join(root, 'user-commands');
  workspaceCwd = join(root, 'ws');
  workspaceDir = join(workspaceCwd, '.qwen', 'commands');
  await mkdir(userDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function loader(audit?: AuditRecorder): CommandLoader {
  return new CommandLoader(async () => workspaceCwd, userDir, audit);
}

const VALID = (name: string, scope = 'write') =>
  `---\nname: ${name}\ndescription: does ${name}\nscope: ${scope}\n---\nBody for ${name} ${'${arg}'}`;

describe('CommandLoader', () => {
  it('loads a valid workspace command', async () => {
    await writeFile(join(workspaceDir, 'triage.md'), VALID('triage'));
    const cmds = await loader().load();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({
      name: 'triage',
      description: 'does triage',
      scope: 'write',
      sessionScope: 'required',
      source: 'workspace',
    });
    expect(cmds[0].body).toContain('Body for triage');
  });

  it('captures optional tool + sessionScope', async () => {
    await writeFile(
      join(workspaceDir, 'sh.md'),
      `---\nname: sh\ndescription: shell\nscope: write\ntool: shell\nsessionScope: none\n---\nbody`,
    );
    const cmds = await loader().load();
    expect(cmds[0].tool).toBe('shell');
    expect(cmds[0].sessionScope).toBe('none');
  });

  it('skips a file with a bad name', async () => {
    await writeFile(join(workspaceDir, 'bad.md'), VALID('Bad-NAME!'));
    expect(await loader().load()).toHaveLength(0);
  });

  it('skips a file with a bad scope', async () => {
    await writeFile(join(workspaceDir, 'x.md'), VALID('x', 'nonsense'));
    expect(await loader().load()).toHaveLength(0);
  });

  it('skips a file declaring owner scope', async () => {
    await writeFile(join(workspaceDir, 'x.md'), VALID('x', 'owner'));
    expect(await loader().load()).toHaveLength(0);
  });

  it('skips a file declaring bridge scope', async () => {
    await writeFile(join(workspaceDir, 'x.md'), VALID('x', 'bridge'));
    expect(await loader().load()).toHaveLength(0);
  });

  it('skips a file with no front-matter', async () => {
    await writeFile(join(workspaceDir, 'x.md'), 'just a body, no front matter');
    expect(await loader().load()).toHaveLength(0);
  });

  it('skips a file missing a description', async () => {
    await writeFile(
      join(workspaceDir, 'x.md'),
      `---\nname: x\nscope: write\n---\nbody`,
    );
    expect(await loader().load()).toHaveLength(0);
  });

  it('clamps description to 140 chars', async () => {
    const longDesc = 'd'.repeat(300);
    await writeFile(
      join(workspaceDir, 'x.md'),
      `---\nname: x\ndescription: ${longDesc}\nscope: write\n---\nbody`,
    );
    const cmds = await loader().load();
    expect(cmds[0].description).toHaveLength(140);
  });

  it('loads from both roots and sorts by name', async () => {
    await writeFile(join(userDir, 'zeta.md'), VALID('zeta'));
    await writeFile(join(workspaceDir, 'alpha.md'), VALID('alpha'));
    const cmds = await loader().load();
    expect(cmds.map((c) => c.name)).toEqual(['alpha', 'zeta']);
  });

  it('workspace shadows user on name collision and audits once', async () => {
    await writeFile(join(userDir, 'dup.md'), VALID('dup'));
    await writeFile(
      join(workspaceDir, 'dup.md'),
      `---\nname: dup\ndescription: WS WINS\nscope: write\n---\nws body`,
    );
    const audit = new FakeAudit();
    const cmds = await loader(audit).load();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].source).toBe('workspace');
    expect(cmds[0].description).toBe('WS WINS');
    const collisions = audit.entries.filter(
      (e) => e.action === 'command_collision_workspace_wins',
    );
    expect(collisions).toHaveLength(1);
    expect(collisions[0].detail).toMatchObject({ name: 'dup' });
  });

  it('audits a collision only once across multiple load() calls', async () => {
    await writeFile(join(userDir, 'dup.md'), VALID('dup'));
    await writeFile(join(workspaceDir, 'dup.md'), VALID('dup'));
    const audit = new FakeAudit();
    const l = loader(audit);
    await l.load();
    await l.load();
    await l.load();
    const collisions = audit.entries.filter(
      (e) => e.action === 'command_collision_workspace_wins',
    );
    expect(collisions).toHaveLength(1);
  });

  it('returns [] when both dirs are missing', async () => {
    const l = new CommandLoader(
      async () => join(root, 'no-such-ws'),
      join(root, 'no-such-user'),
    );
    expect(await l.load()).toEqual([]);
  });

  it('treats an undefined workspace cwd as no workspace dir', async () => {
    await writeFile(join(userDir, 'u.md'), VALID('u'));
    const l = new CommandLoader(async () => undefined, userDir);
    const cmds = await l.load();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].source).toBe('user');
  });

  // C1: an unreadable root (here a regular file at the user-commands path →
  // ENOTDIR) must not reject out of load() — that would hang the route in
  // express 4 (no error middleware). It contributes no commands instead.
  it('returns [] for a root that is a regular file (ENOTDIR), not throwing', async () => {
    const filePath = join(root, 'a-file');
    await writeFile(filePath, 'not a directory');
    await writeFile(join(workspaceDir, 'ws.md'), VALID('ws'));
    const l = new CommandLoader(async () => workspaceCwd, filePath);
    const cmds = await l.load();
    // The bad user root yields nothing; the good workspace root still loads.
    expect(cmds.map((c) => c.name)).toEqual(['ws']);
  });

  // M2: two workspace files with the same name is NOT a workspace-wins-over-user
  // collision; no user command of that name exists.
  it('does not audit a collision when one workspace file shadows another', async () => {
    await writeFile(join(workspaceDir, 'a.md'), VALID('dup'));
    await writeFile(join(workspaceDir, 'b.md'), VALID('dup'));
    const audit = new FakeAudit();
    await loader(audit).load();
    const collisions = audit.entries.filter(
      (e) => e.action === 'command_collision_workspace_wins',
    );
    expect(collisions).toHaveLength(0);
  });

  it('parses a valid args declaration (required + default)', async () => {
    await writeFile(
      join(workspaceDir, 'fix.md'),
      `---\nname: fix\ndescription: fix an issue\nscope: write\nargs:\n  - name: issue\n    required: true\n  - name: branch\n    default: main\n---\nfix #${'${arg}'} on ${'${arg.1}'}`,
    );
    const cmds = await loader().load();
    expect(cmds[0].args).toEqual([
      { name: 'issue', required: true },
      { name: 'branch', required: false, default: 'main' },
    ]);
  });

  it('a command with no args declaration has args undefined (pass-through)', async () => {
    await writeFile(join(workspaceDir, 'triage.md'), VALID('triage'));
    const cmds = await loader().load();
    expect(cmds[0].args).toBeUndefined();
  });

  it('rejects a malformed args declaration + audits slash_command_parse_failed', async () => {
    const audit = new FakeAudit();
    // args is a scalar, not a sequence.
    await writeFile(
      join(workspaceDir, 'bad.md'),
      `---\nname: bad\ndescription: bad\nscope: write\nargs: 7\n---\nbody`,
    );
    const cmds = await loader(audit).load();
    expect(cmds).toHaveLength(0);
    const pf = audit.entries.find(
      (e) => e.action === 'slash_command_parse_failed',
    );
    expect(pf?.detail).toMatchObject({
      file: 'bad.md',
      source: 'workspace',
      reason: 'args',
    });
  });

  it.each([
    ['element not a mapping', `args:\n  - just-a-string`],
    ['bad arg name', `args:\n  - name: "1bad"`],
    ['non-boolean required', `args:\n  - name: x\n    required: yes-ish\n`],
    ['non-string default', `args:\n  - name: x\n    default: 5`],
  ])('rejects args (%s)', async (_label, argsBlock) => {
    await writeFile(
      join(workspaceDir, 'bad.md'),
      `---\nname: bad\ndescription: bad\nscope: write\n${argsBlock}\n---\nbody`,
    );
    const cmds = await loader().load();
    expect(cmds).toHaveLength(0);
  });

  it('a bad scope also emits slash_command_parse_failed (reason: scope)', async () => {
    const audit = new FakeAudit();
    await writeFile(
      join(workspaceDir, 'bad.md'),
      `---\nname: bad\ndescription: bad\nscope: owner\n---\nbody`,
    );
    await loader(audit).load();
    expect(
      audit.entries.find((e) => e.action === 'slash_command_parse_failed')
        ?.detail,
    ).toMatchObject({ reason: 'scope' });
  });

  it('a .md file with NO front-matter is skipped silently (no parse_failed)', async () => {
    const audit = new FakeAudit();
    await writeFile(
      join(workspaceDir, 'README.md'),
      `# Just a readme\n\nNo front matter here.`,
    );
    const cmds = await loader(audit).load();
    expect(cmds).toHaveLength(0);
    expect(
      audit.entries.some((e) => e.action === 'slash_command_parse_failed'),
    ).toBe(false);
  });

  it('a file opening with --- but broken YAML → parse_failed (reason: frontmatter)', async () => {
    const audit = new FakeAudit();
    // Opens with `---` (intended command) but the YAML is malformed.
    await writeFile(
      join(workspaceDir, 'broken.md'),
      `---\nname: [unterminated flow\n---\nbody`,
    );
    const cmds = await loader(audit).load();
    expect(cmds).toHaveLength(0);
    expect(
      audit.entries.find((e) => e.action === 'slash_command_parse_failed')
        ?.detail,
    ).toMatchObject({ file: 'broken.md', reason: 'frontmatter' });
  });

  it('parse_failed is audited once per file+reason across repeated load() calls', async () => {
    const audit = new FakeAudit();
    await writeFile(
      join(workspaceDir, 'bad.md'),
      `---\nname: bad\ndescription: bad\nscope: owner\n---\nbody`,
    );
    const ldr = loader(audit);
    await ldr.load();
    await ldr.load();
    await ldr.load();
    expect(
      audit.entries.filter((e) => e.action === 'slash_command_parse_failed'),
    ).toHaveLength(1);
  });
});

describe('CommandLoader mtime cache (cycle 78)', () => {
  it('returns the same array reference while files are unchanged (cache hit)', async () => {
    await writeFile(join(userDir, 'a.md'), VALID('a'));
    const l = loader();
    const r1 = await l.load();
    const r2 = await l.load();
    expect(r1.map((c) => c.name)).toEqual(['a']);
    expect(r2).toBe(r1); // cache hit → no re-read/parse, same reference
  });

  it('invalidates when a command file is ADDED', async () => {
    await writeFile(join(userDir, 'a.md'), VALID('a'));
    const l = loader();
    const r1 = await l.load();
    expect(r1.map((c) => c.name)).toEqual(['a']);
    await writeFile(join(userDir, 'b.md'), VALID('b'));
    const r2 = await l.load();
    expect(r2).not.toBe(r1);
    expect(r2.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('invalidates when a command file is REMOVED', async () => {
    await writeFile(join(userDir, 'a.md'), VALID('a'));
    await writeFile(join(userDir, 'b.md'), VALID('b'));
    const l = loader();
    expect((await l.load()).map((c) => c.name)).toEqual(['a', 'b']);
    await rm(join(userDir, 'b.md'));
    expect((await l.load()).map((c) => c.name)).toEqual(['a']);
  });

  it("invalidates when a file's CONTENT changes (size differs)", async () => {
    await writeFile(join(userDir, 'a.md'), VALID('a'));
    const l = loader();
    const r1 = await l.load();
    expect(r1[0].description).toBe('does a');
    // Rewrite with a longer description → size + mtime change → cache miss.
    await writeFile(
      join(userDir, 'a.md'),
      '---\nname: a\ndescription: does a much more thoroughly\nscope: write\n---\nBody',
    );
    const r2 = await l.load();
    expect(r2).not.toBe(r1);
    expect(r2[0].description).toBe('does a much more thoroughly');
  });
});

describe('CommandLoader parse_failed dedup survives a cache miss (cycle 78)', () => {
  it('does not re-audit a still-broken file when an unrelated change invalidates the cache', async () => {
    const audit = new FakeAudit();
    // A broken command file (invalid scope) → parse_failed once on first load.
    await writeFile(
      join(workspaceDir, 'bad.md'),
      '---\nname: bad\ndescription: bad\nscope: owner\n---\nbody',
    );
    const l = loader(audit);
    await l.load();
    const countAfterFirst = audit.entries.filter(
      (e) => e.action === 'slash_command_parse_failed',
    ).length;
    expect(countAfterFirst).toBe(1);

    // Force a cache MISS via an unrelated valid file → the broken file is
    // re-parsed, but the warnedParseFailures dedup must suppress a re-audit.
    await writeFile(join(userDir, 'ok.md'), VALID('ok'));
    const cmds = await l.load();
    expect(cmds.map((c) => c.name)).toContain('ok'); // proves the cache missed
    const countAfterMiss = audit.entries.filter(
      (e) => e.action === 'slash_command_parse_failed',
    ).length;
    expect(countAfterMiss).toBe(1); // still once across the genuine re-parse
  });
});
