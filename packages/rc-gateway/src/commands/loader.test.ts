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
});
