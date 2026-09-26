/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeMemoryFileChange,
  memoryChangedNoticeFromHookInput,
  notifyMemoryEnabledChange,
  notifyMemoryFileChange,
  registerMemoryChangedListener,
  withCoalescedMemoryChanges,
  type MemoryChangedNotice,
} from './memory-file-change.js';
import {
  rebuildTeamAutoMemoryIndex,
  rebuildUserAutoMemoryIndex,
} from './indexer.js';
import {
  getAutoMemoryConsolidationLockPath,
  getAutoMemoryExtractCursorPath,
  getAutoMemoryMetadataPath,
  getAutoMemoryRoot,
  getTeamAutoMemoryRoot,
  getUserAutoMemoryIndexPath,
  getUserAutoMemoryRoot,
} from './paths.js';

describe('memory file change hook', () => {
  const originalBase = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalBase === undefined) {
      delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    } else {
      process.env['QWEN_CODE_MEMORY_BASE_DIR'] = originalBase;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function setup(): Promise<string> {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-file-change-'));
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = tempDir;
    const projectRoot = path.join(tempDir, 'repo');
    await fs.mkdir(projectRoot, { recursive: true });
    return projectRoot;
  }

  it('classifies user, project, and unrelated paths', async () => {
    const projectRoot = await setup();

    expect(
      describeMemoryFileChange(
        path.join(tempDir!, 'memories', 'user', 'role.md'),
        projectRoot,
      ),
    ).toMatchObject({
      scope: 'user',
      relativePath: 'user/role.md',
    });
    expect(
      describeMemoryFileChange(
        path.join(getAutoMemoryRoot(projectRoot), 'feedback.md'),
        projectRoot,
      ),
    ).toMatchObject({
      scope: 'project',
      relativePath: 'feedback.md',
    });
    expect(
      describeMemoryFileChange(path.join(tempDir!, 'notes.md'), projectRoot),
    ).toBeUndefined();
    for (const schedulingPath of [
      getAutoMemoryMetadataPath(projectRoot),
      getAutoMemoryExtractCursorPath(projectRoot),
      getAutoMemoryConsolidationLockPath(projectRoot),
    ]) {
      expect(
        describeMemoryFileChange(schedulingPath, projectRoot),
      ).toBeUndefined();
    }
  });

  it('notifies listeners only for managed memory files', async () => {
    const projectRoot = await setup();
    const seen: MemoryChangedNotice[] = [];
    const unregister = registerMemoryChangedListener(projectRoot, (change) => {
      seen.push(change);
    });
    try {
      await notifyMemoryFileChange(
        path.join(tempDir!, 'memories', 'MEMORY.md'),
        projectRoot,
        'update',
      );
      await notifyMemoryFileChange(
        path.join(tempDir!, 'notes.md'),
        projectRoot,
        'update',
      );
      await notifyMemoryFileChange(
        getAutoMemoryMetadataPath(projectRoot),
        projectRoot,
        'update',
      );
    } finally {
      unregister();
    }
    expect(seen).toEqual([
      expect.objectContaining({
        scope: 'user',
        operation: 'update',
        relativePaths: ['MEMORY.md'],
      }),
    ]);
    expect(seen[0]).not.toHaveProperty('workspace');
    expect(seen[0]).not.toHaveProperty('enabled');
    expect(seen[0]).toMatchObject({
      paths: [path.join(await fs.realpath(tempDir!), 'memories', 'MEMORY.md')],
    });
  });

  it('sends one path alone and paths changed together as one array', async () => {
    const projectRoot = await setup();
    const seen: MemoryChangedNotice[] = [];
    const unregister = registerMemoryChangedListener(projectRoot, (change) => {
      seen.push(change);
    });
    const role = path.join(tempDir!, 'memories', 'user', 'role.md');
    const feedback = path.join(tempDir!, 'memories', 'feedback', 'tone.md');
    try {
      await notifyMemoryFileChange(role, projectRoot, 'update');
      await notifyMemoryFileChange([role, feedback], projectRoot, 'update');
    } finally {
      unregister();
    }
    expect(
      seen.map((change) =>
        'relativePaths' in change ? change.relativePaths : [],
      ),
    ).toEqual([['user/role.md'], ['user/role.md', 'feedback/tone.md']]);
  });

  it('splits mixed scopes and keeps workspace on project and team memory', async () => {
    const projectRoot = await setup();
    const seen: MemoryChangedNotice[] = [];
    const unregister = registerMemoryChangedListener(projectRoot, (change) => {
      seen.push(change);
    });
    const userFile = path.join(tempDir!, 'memories', 'user', 'role.md');
    const projectFile = path.join(getAutoMemoryRoot(projectRoot), 'a.md');
    const teamFile = path.join(getTeamAutoMemoryRoot(projectRoot), 'b.md');
    try {
      await notifyMemoryFileChange(
        [userFile, projectFile, teamFile],
        projectRoot,
        'create',
      );
    } finally {
      unregister();
    }
    expect(seen).toEqual([
      expect.objectContaining({
        scope: 'user',
        operation: 'create',
        relativePaths: ['user/role.md'],
      }),
      expect.objectContaining({
        scope: 'project',
        operation: 'create',
        relativePaths: ['a.md'],
        workspace: projectRoot,
      }),
      expect.objectContaining({
        scope: 'team',
        operation: 'create',
        relativePaths: ['b.md'],
        workspace: projectRoot,
      }),
    ]);
    expect(seen[0]).not.toHaveProperty('workspace');
  });

  it('reports the on/off toggle without document paths', async () => {
    const projectRoot = await setup();
    const seen: MemoryChangedNotice[] = [];
    const unregister = registerMemoryChangedListener(projectRoot, (change) => {
      seen.push(change);
    });
    try {
      await notifyMemoryEnabledChange(projectRoot, false);
    } finally {
      unregister();
    }
    expect(seen).toEqual([
      {
        paths: [],
        relativePaths: [],
        workspace: projectRoot,
        enabled: false,
      },
    ]);
  });

  it('isolates a listener failure from the write', async () => {
    const projectRoot = await setup();
    const seen: string[] = [];
    const unregisterFail = registerMemoryChangedListener(projectRoot, () => {
      throw new Error('upload failed');
    });
    const unregisterOk = registerMemoryChangedListener(projectRoot, () => {
      seen.push('ok');
    });
    try {
      await expect(
        notifyMemoryFileChange(
          path.join(tempDir!, 'memories', 'MEMORY.md'),
          projectRoot,
          'delete',
        ),
      ).resolves.toBeUndefined();
    } finally {
      unregisterFail();
      unregisterOk();
    }
    expect(seen).toEqual(['ok']);
  });

  it('does not deliver a write to another workspace', async () => {
    const projectRoot = await setup();
    const seen: MemoryChangedNotice[] = [];
    const unregister = registerMemoryChangedListener(
      path.join(tempDir!, 'other'),
      (change) => {
        seen.push(change);
      },
    );
    try {
      await notifyMemoryFileChange(
        path.join(tempDir!, 'memories', 'MEMORY.md'),
        projectRoot,
        'update',
      );
    } finally {
      unregister();
    }
    expect(seen).toEqual([]);
  });

  it('does not route an empty project root to a registered workspace', async () => {
    const projectRoot = await setup();
    const seen: MemoryChangedNotice[] = [];
    const unregister = registerMemoryChangedListener(projectRoot, (change) => {
      seen.push(change);
    });
    try {
      await notifyMemoryFileChange(
        path.join(tempDir!, 'memories', 'MEMORY.md'),
        '',
        'update',
      );
    } finally {
      unregister();
    }
    expect(seen).toEqual([]);
  });

  it('stops delivery after the listener is unregistered', async () => {
    const projectRoot = await setup();
    const seen: MemoryChangedNotice[] = [];
    const unregister = registerMemoryChangedListener(projectRoot, (change) => {
      seen.push(change);
    });
    unregister();
    const again = registerMemoryChangedListener(projectRoot, (change) => {
      seen.push(change);
    });
    try {
      await notifyMemoryFileChange(
        path.join(tempDir!, 'memories', 'MEMORY.md'),
        projectRoot,
        'update',
      );
    } finally {
      again();
    }
    expect(seen).toHaveLength(1);
  });

  it('rebuilds a document notice and a toggle from hook input', () => {
    expect(
      memoryChangedNoticeFromHookInput({
        paths: ['/memories/user/role.md'],
        relative_paths: ['user/role.md'],
        memory_scope: 'user',
        operation: 'update',
      }),
    ).toEqual({
      scope: 'user',
      operation: 'update',
      paths: ['/memories/user/role.md'],
      relativePaths: ['user/role.md'],
    });
    expect(
      memoryChangedNoticeFromHookInput({
        paths: [],
        workspace: '/repo',
        enabled: false,
      }),
    ).toEqual({
      paths: [],
      relativePaths: [],
      workspace: '/repo',
      enabled: false,
    });
    expect(
      memoryChangedNoticeFromHookInput({ operation: 'nope' }),
    ).toBeUndefined();
  });

  it.each([
    { enabled: true },
    { enabled: false, workspace: '' },
    { enabled: true, workspace: '   ' },
    { memory_scope: 'user', operation: 'update' },
    {
      memory_scope: 'user',
      operation: 'update',
      paths: [],
      relative_paths: [],
    },
    {
      memory_scope: 'project',
      operation: 'update',
      paths: ['/repo/.qwen/memory/a.md'],
      relative_paths: ['a.md'],
    },
    {
      memory_scope: 'team',
      operation: 'update',
      paths: ['/repo/.qwen/team-memory/a.md'],
      relative_paths: ['a.md'],
      workspace: '',
    },
    {
      memory_scope: 'user',
      operation: 'update',
      paths: [''],
      relative_paths: ['a.md'],
    },
    {
      memory_scope: 'user',
      operation: 'update',
      paths: ['/memories/a.md'],
      relative_paths: [''],
    },
    {
      memory_scope: 'user',
      operation: 'update',
      paths: ['/memories/a.md', '/memories/c.md'],
      relative_paths: ['a.md', 'b.md', 'c.md'],
    },
    {
      memory_scope: 'user',
      operation: 'update',
      paths: ['/memories/a.md', 42, '/memories/c.md'],
      relative_paths: ['a.md', 'b.md', 'c.md'],
    },
    {
      memory_scope: 'user',
      operation: 'update',
      paths: ['/memories/a.md', '/memories/b.md'],
      relative_paths: ['a.md', 42],
    },
  ])('rejects malformed hook input %#', (input) => {
    expect(memoryChangedNoticeFromHookInput(input)).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32').each([
    { scope: 'team', canonicalFile: true },
    { scope: 'team', canonicalFile: false },
    { scope: 'project', canonicalFile: true },
    { scope: 'project', canonicalFile: false },
  ] as const)(
    'notifies $scope memory across a workspace alias (canonicalFile=$canonicalFile)',
    async ({ scope, canonicalFile }) => {
      await setup();
      const realParent = path.join(tempDir!, 'real');
      const realRoot = path.join(realParent, 'repo');
      const linkedParent = path.join(tempDir!, 'link');
      const linkedRoot = path.join(linkedParent, 'repo');
      await fs.mkdir(realRoot, { recursive: true });
      await fs.symlink(realParent, linkedParent, 'dir');
      const originalLocal = process.env['QWEN_CODE_MEMORY_LOCAL'];
      process.env['QWEN_CODE_MEMORY_LOCAL'] = '1';
      const workspace = canonicalFile ? linkedRoot : realRoot;
      const fileRoot = canonicalFile ? realRoot : linkedRoot;
      const file = path.join(
        fileRoot,
        '.qwen',
        scope === 'team' ? 'team-memory' : 'memory',
        'a.md',
      );
      const seen: MemoryChangedNotice[] = [];
      const unregister = registerMemoryChangedListener(workspace, (change) => {
        seen.push(change);
      });
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, 'new memory');
        await notifyMemoryFileChange(file, workspace, 'create');
        expect(seen).toEqual([
          expect.objectContaining({
            scope,
            operation: 'create',
            relativePaths: ['a.md'],
            workspace,
          }),
        ]);
      } finally {
        unregister();
        if (originalLocal === undefined) {
          delete process.env['QWEN_CODE_MEMORY_LOCAL'];
        } else {
          process.env['QWEN_CODE_MEMORY_LOCAL'] = originalLocal;
        }
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not classify a team child symlink that escapes its root',
    async () => {
      const workspace = await setup();
      const outsideRoot = path.join(tempDir!, 'outside');
      const root = getTeamAutoMemoryRoot(workspace);
      await fs.mkdir(outsideRoot);
      await fs.writeFile(path.join(outsideRoot, 'a.md'), 'outside');
      await fs.mkdir(root, { recursive: true });
      await fs.symlink(outsideRoot, path.join(root, 'linked'), 'dir');
      expect(
        describeMemoryFileChange(path.join(root, 'linked', 'a.md'), workspace),
      ).toBeUndefined();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not classify an outside document through a relocated team root',
    async () => {
      const workspace = await setup();
      const outsideRoot = path.join(tempDir!, 'outside');
      const file = path.join(outsideRoot, 'a.md');
      await fs.mkdir(outsideRoot);
      await fs.writeFile(file, 'outside');
      await fs.mkdir(path.join(workspace, '.qwen'));
      await fs.symlink(outsideRoot, getTeamAutoMemoryRoot(workspace), 'dir');
      expect(describeMemoryFileChange(file, workspace)).toBeUndefined();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'emits a coalesced alias write exactly once with a readable path',
    async () => {
      await setup();
      const realParent = path.join(tempDir!, 'real');
      const workspace = path.join(tempDir!, 'link', 'repo');
      const file = path.join(realParent, 'repo/.qwen/team-memory/a.md');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.symlink(realParent, path.join(tempDir!, 'link'), 'dir');
      const seen: MemoryChangedNotice[] = [];
      const unregister = registerMemoryChangedListener(workspace, (change) => {
        seen.push(change);
      });
      try {
        await withCoalescedMemoryChanges(workspace, undefined, async () => {
          await fs.writeFile(file, 'new memory');
          await notifyMemoryFileChange(file, workspace, 'create');
          expect(seen).toEqual([]);
        });
        expect(seen).toEqual([
          expect.objectContaining({
            scope: 'team',
            operation: 'create',
            relativePaths: ['a.md'],
            workspace,
          }),
        ]);
        expect(await fs.readFile(seen[0]!.paths[0]!, 'utf8')).toBe(
          'new memory',
        );
      } finally {
        unregister();
      }
    },
  );

  it('delivers a write to the named registration when several share a workspace', async () => {
    const projectRoot = await setup();
    const first: MemoryChangedNotice[] = [];
    const second: MemoryChangedNotice[] = [];
    const firstRegistration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        first.push(change);
      },
    );
    const secondRegistration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        second.push(change);
      },
    );
    const file = path.join(tempDir!, 'memories', 'MEMORY.md');
    try {
      await notifyMemoryFileChange(file, projectRoot, 'update');
      await notifyMemoryFileChange(
        file,
        projectRoot,
        'update',
        firstRegistration.id,
      );
    } finally {
      firstRegistration();
      secondRegistration();
    }
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('delivers to a live named registration even when the notify names another workspace', async () => {
    const projectRoot = await setup();
    const other = path.join(tempDir!, 'other');
    const elsewhereSeen: MemoryChangedNotice[] = [];
    const hereSeen: MemoryChangedNotice[] = [];
    const elsewhere = registerMemoryChangedListener(other, (change) => {
      elsewhereSeen.push(change);
    });
    const here = registerMemoryChangedListener(projectRoot, (change) => {
      hereSeen.push(change);
    });
    try {
      await notifyMemoryFileChange(
        path.join(tempDir!, 'memories', 'MEMORY.md'),
        projectRoot,
        'update',
        elsewhere.id,
      );
    } finally {
      elsewhere();
      here();
    }
    // A delivery id names one registration globally (the ids are unique
    // symbols): a Config relocated by /cd or a derived worktree Config
    // notifies with its live root, which no longer equals the key the
    // registration was made under.
    expect(elsewhereSeen).toHaveLength(1);
    expect(hereSeen).toEqual([]);
  });

  it('delivers nothing for a delivery id whose registration is gone', async () => {
    const projectRoot = await setup();
    const seen: MemoryChangedNotice[] = [];
    const gone = registerMemoryChangedListener(projectRoot, (change) => {
      seen.push(change);
    });
    const staleId = gone.id;
    gone();
    const alive = registerMemoryChangedListener(projectRoot, (change) => {
      seen.push(change);
    });
    const file = path.join(tempDir!, 'memories', 'MEMORY.md');
    try {
      await notifyMemoryFileChange(file, projectRoot, 'update', staleId);
      expect(seen).toEqual([]);
      // Control: an id-less notify still falls back to the newest
      // registration for the workspace.
      await notifyMemoryFileChange(file, projectRoot, 'update');
      expect(seen).toHaveLength(1);
    } finally {
      alive();
    }
  });

  it('emits create for a file that appears inside a coalesced window', async () => {
    const projectRoot = await setup();
    const file = path.join(tempDir!, 'memories', 'user', 'new.md');
    const seen: MemoryChangedNotice[] = [];
    const registration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        seen.push(change);
      },
    );
    try {
      await withCoalescedMemoryChanges(
        projectRoot,
        registration.id,
        async () => {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, 'new\n');
        },
      );
    } finally {
      registration();
    }
    expect(seen).toEqual([
      expect.objectContaining({
        operation: 'create',
        relativePaths: ['user/new.md'],
      }),
    ]);
  });

  it('does not report an outside write again in the coalesced diff', async () => {
    const projectRoot = await setup();
    const file = path.join(tempDir!, 'memories', 'user', 'outside.md');
    const writer: MemoryChangedNotice[] = [];
    const windowSeen: MemoryChangedNotice[] = [];
    const writerRegistration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        writer.push(change);
      },
    );
    const windowRegistration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        windowSeen.push(change);
      },
    );
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const pending = withCoalescedMemoryChanges(
        projectRoot,
        windowRegistration.id,
        () => gate,
      );
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'out\n');
      await notifyMemoryFileChange(
        file,
        projectRoot,
        'create',
        writerRegistration.id,
      );
      release();
      await pending;
    } finally {
      writerRegistration();
      windowRegistration();
    }
    expect(writer).toEqual([
      expect.objectContaining({
        operation: 'create',
        relativePaths: ['user/outside.md'],
      }),
    ]);
    expect(windowSeen).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'does not repeat an alias writer change in a canonical workspace window',
    async () => {
      await setup();
      const realParent = path.join(tempDir!, 'real');
      const canonicalWorkspace = path.join(realParent, 'repo');
      const aliasWorkspace = path.join(tempDir!, 'link', 'repo');
      const file = path.join(canonicalWorkspace, '.qwen/team-memory/a.md');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.symlink(realParent, path.join(tempDir!, 'link'), 'dir');
      const writer: MemoryChangedNotice[] = [];
      const windowSeen: MemoryChangedNotice[] = [];
      const writerRegistration = registerMemoryChangedListener(
        aliasWorkspace,
        (change) => {
          writer.push(change);
        },
      );
      const windowRegistration = registerMemoryChangedListener(
        canonicalWorkspace,
        (change) => {
          windowSeen.push(change);
        },
      );
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = withCoalescedMemoryChanges(
        canonicalWorkspace,
        windowRegistration.id,
        async () => {
          open();
          await gate;
        },
      );
      try {
        await opened;
        await fs.writeFile(file, 'outside write');
        await notifyMemoryFileChange(
          file,
          aliasWorkspace,
          'create',
          writerRegistration.id,
        );
      } finally {
        release();
        await pending;
        writerRegistration();
        windowRegistration();
      }
      expect(writer).toEqual([
        expect.objectContaining({
          scope: 'team',
          operation: 'create',
          relativePaths: ['a.md'],
        }),
      ]);
      expect(windowSeen).toEqual([]);
    },
  );

  it('still reports a window change to a path an outside write already reported', async () => {
    const projectRoot = await setup();
    const file = path.join(tempDir!, 'memories', 'user', 'shared.md');
    const writer: MemoryChangedNotice[] = [];
    const windowSeen: MemoryChangedNotice[] = [];
    const writerRegistration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        writer.push(change);
      },
    );
    const windowRegistration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        windowSeen.push(change);
      },
    );
    let outsideDone: () => void = () => {};
    const outsideReported = new Promise<void>((resolve) => {
      outsideDone = resolve;
    });
    try {
      const pending = withCoalescedMemoryChanges(
        projectRoot,
        windowRegistration.id,
        async () => {
          await outsideReported;
          await fs.writeFile(file, 'rewritten by the window\n');
        },
      );
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'out\n');
      await notifyMemoryFileChange(
        file,
        projectRoot,
        'create',
        writerRegistration.id,
      );
      outsideDone();
      await pending;
    } finally {
      writerRegistration();
      windowRegistration();
    }
    expect(writer).toEqual([expect.objectContaining({ operation: 'create' })]);
    expect(windowSeen).toEqual([
      expect.objectContaining({
        operation: 'update',
        relativePaths: ['user/shared.md'],
      }),
    ]);
  });

  it.each([
    {
      name: 'reports a window delete of a path an outside write created',
      before: undefined,
      outside: 'create' as const,
      window: 'rm' as const,
      expected: 'delete',
    },
    {
      name: 'reports a window re-create of a path an outside write deleted',
      before: 'old\n',
      outside: 'delete' as const,
      window: 'write' as const,
      expected: 'create',
    },
  ])('$name', async ({ before, outside, window, expected }) => {
    const projectRoot = await setup();
    const file = path.join(tempDir!, 'memories', 'user', 'shared.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (before !== undefined) await fs.writeFile(file, before);
    const windowSeen: MemoryChangedNotice[] = [];
    const writerRegistration = registerMemoryChangedListener(
      projectRoot,
      () => {},
    );
    const windowRegistration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        windowSeen.push(change);
      },
    );
    let windowOpened: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      windowOpened = resolve;
    });
    let outsideDone: () => void = () => {};
    const outsideReported = new Promise<void>((resolve) => {
      outsideDone = resolve;
    });
    try {
      const pending = withCoalescedMemoryChanges(
        projectRoot,
        windowRegistration.id,
        async () => {
          windowOpened();
          await outsideReported;
          if (window === 'rm') await fs.rm(file);
          else await fs.writeFile(file, 'back\n');
        },
      );
      // The window has taken its snapshot before the outside write lands.
      await opened;
      if (outside === 'delete') await fs.rm(file);
      else await fs.writeFile(file, 'out\n');
      await notifyMemoryFileChange(
        file,
        projectRoot,
        outside,
        writerRegistration.id,
      );
      outsideDone();
      await pending;
    } finally {
      writerRegistration();
      windowRegistration();
    }
    expect(windowSeen).toEqual([
      expect.objectContaining({
        operation: expected,
        relativePaths: ['user/shared.md'],
      }),
    ]);
  });

  it('does not cross-report a write made inside a sibling window', async () => {
    const projectRoot = await setup();
    const file = path.join(tempDir!, 'memories', 'user', 'sibling.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const aSeen: MemoryChangedNotice[] = [];
    const bSeen: MemoryChangedNotice[] = [];
    const aRegistration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        aSeen.push(change);
      },
    );
    const bRegistration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        bSeen.push(change);
      },
    );
    let aOpened: () => void = () => {};
    const aOpenGate = new Promise<void>((resolve) => {
      aOpened = resolve;
    });
    let closeA: () => void = () => {};
    const aCloseGate = new Promise<void>((resolve) => {
      closeA = resolve;
    });
    let bWrote: () => void = () => {};
    const bWriteGate = new Promise<void>((resolve) => {
      bWrote = resolve;
    });
    let closeB: () => void = () => {};
    const bCloseGate = new Promise<void>((resolve) => {
      closeB = resolve;
    });
    try {
      const aPending = withCoalescedMemoryChanges(
        projectRoot,
        aRegistration.id,
        async () => {
          aOpened();
          await aCloseGate;
        },
      );
      // A's before-snapshot has completed once its fn starts.
      await aOpenGate;
      const bPending = withCoalescedMemoryChanges(
        projectRoot,
        bRegistration.id,
        async () => {
          await fs.writeFile(file, 'from b\n');
          // Suppressed inside B's own window; B reports it in its own diff.
          await notifyMemoryFileChange(
            file,
            projectRoot,
            'create',
            bRegistration.id,
          );
          bWrote();
          await bCloseGate;
        },
      );
      await bWriteGate;
      // A closes while B is still open: B's write was suppressed, so without
      // the cross-window baseline A's diff reports B's write as A's own.
      closeA();
      await aPending;
      closeB();
      await bPending;
    } finally {
      aRegistration();
      bRegistration();
    }
    expect(bSeen).toEqual([
      expect.objectContaining({
        operation: 'create',
        relativePaths: ['user/sibling.md'],
      }),
    ]);
    expect(aSeen).toEqual([]);
  });

  it('does not turn a sibling write to a symlinked document into a window delete', async () => {
    const projectRoot = await setup();
    const target = path.join(tempDir!, 'vault', 'role.md');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'v1\n');
    const link = path.join(tempDir!, 'memories', 'user', 'role.md');
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link);
    const writerSeen: MemoryChangedNotice[] = [];
    const windowSeen: MemoryChangedNotice[] = [];
    const writerRegistration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        writerSeen.push(change);
      },
    );
    const windowRegistration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        windowSeen.push(change);
      },
    );
    let outsideDone: () => void = () => {};
    const outsideReported = new Promise<void>((resolve) => {
      outsideDone = resolve;
    });
    try {
      const pending = withCoalescedMemoryChanges(
        projectRoot,
        windowRegistration.id,
        () => outsideReported,
      );
      await fs.writeFile(target, 'v2\n');
      await notifyMemoryFileChange(
        link,
        projectRoot,
        'update',
        writerRegistration.id,
      );
      outsideDone();
      await pending;
    } finally {
      writerRegistration();
      windowRegistration();
    }
    // The tree walk cannot see a symlink (Dirent.isFile() is false), so the
    // window must not turn the recorded outside write into a `delete` for a
    // file that is still on disk.
    expect(windowSeen).toEqual([]);
    expect(writerSeen).toEqual([
      expect.objectContaining({
        operation: 'update',
        relativePaths: ['user/role.md'],
      }),
    ]);
  });

  // chmod 0o000 denies reads only for a non-root user on POSIX: on Windows
  // or as root the 'unreadable' file stays readable and the case passes
  // vacuously. Skip there instead. Symlinks need creation privileges on
  // Windows, so symlink cases skip there too.
  const noPosixPermissions =
    process.platform === 'win32' || process.getuid?.() === 0;
  const noSymlinks = process.platform === 'win32';

  it.skipIf(noPosixPermissions)(
    'resolves through an unreadable document and still reports the rest',
    async () => {
      const projectRoot = await setup();
      const userRoot = path.join(tempDir!, 'memories');
      const stuck = path.join(userRoot, 'user', 'stuck.md');
      await fs.mkdir(path.dirname(stuck), { recursive: true });
      await fs.writeFile(stuck, 'locked\n');
      await fs.writeFile(path.join(userRoot, 'user', 'keep.md'), 'keep\n');
      const seen: MemoryChangedNotice[] = [];
      const registration = registerMemoryChangedListener(
        projectRoot,
        (change) => {
          seen.push(change);
        },
      );
      try {
        const result = await withCoalescedMemoryChanges(
          projectRoot,
          registration.id,
          async () => {
            // After the before-snapshot, one document stops being readable.
            await fs.chmod(stuck, 0o000);
            await fs.writeFile(path.join(userRoot, 'user', 'new.md'), 'new\n');
            return 'fn-result';
          },
        );
        // The after snapshot runs in a finally; its failure must never replace
        // fn's result.
        expect(result).toBe('fn-result');
      } finally {
        await fs.chmod(stuck, 0o644).catch(() => undefined);
        registration();
      }
      // The unreadable file is unknown, not deleted; the new file is a create.
      expect(seen).toEqual([
        expect.objectContaining({
          operation: 'create',
          relativePaths: ['user/new.md'],
        }),
      ]);
    },
  );

  it.skipIf(noPosixPermissions)(
    'keeps the snapshot baseline when an outside emit cannot stat the file',
    async () => {
      const projectRoot = await setup();
      const dir = path.join(tempDir!, 'memories', 'user');
      const file = path.join(dir, 'jammed.md');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, 'same\n');
      const windowSeen: MemoryChangedNotice[] = [];
      const writerRegistration = registerMemoryChangedListener(
        projectRoot,
        () => {},
      );
      const windowRegistration = registerMemoryChangedListener(
        projectRoot,
        (change) => {
          windowSeen.push(change);
        },
      );
      let windowOpened: () => void = () => {};
      const opened = new Promise<void>((resolve) => {
        windowOpened = resolve;
      });
      let outsideDone: () => void = () => {};
      const outsideReported = new Promise<void>((resolve) => {
        outsideDone = resolve;
      });
      try {
        const pending = withCoalescedMemoryChanges(
          projectRoot,
          windowRegistration.id,
          async () => {
            windowOpened();
            await outsideReported;
          },
        );
        // The window has taken its before-snapshot once fn starts.
        await opened;
        // The notify's stat hits a transient EACCES (the parent directory is
        // not searchable): 'unknown' is not 'absent', so nothing may be
        // recorded — a null baseline would mislabel the untouched file.
        await fs.chmod(dir, 0o000);
        await notifyMemoryFileChange(
          file,
          projectRoot,
          'update',
          writerRegistration.id,
        );
        await fs.chmod(dir, 0o755);
        outsideDone();
        await pending;
      } finally {
        await fs.chmod(dir, 0o755).catch(() => undefined);
        writerRegistration();
        windowRegistration();
      }
      expect(windowSeen).toEqual([]);
    },
  );

  it('emits nothing from the window when a memory root cannot be enumerated', async () => {
    const projectRoot = await setup();
    const userRoot = path.join(tempDir!, 'memories');
    const doc = path.join(userRoot, 'user', 'keep.md');
    await fs.mkdir(path.dirname(doc), { recursive: true });
    await fs.writeFile(doc, 'keep\n');
    const seen: MemoryChangedNotice[] = [];
    const registration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        seen.push(change);
      },
    );
    try {
      await withCoalescedMemoryChanges(
        projectRoot,
        registration.id,
        async () => {
          // After the before-snapshot, the user root stops being enumerable:
          // it is replaced by a plain file (readdir -> ENOTDIR).
          await fs.rm(userRoot, { recursive: true });
          await fs.writeFile(userRoot, 'not a directory');
        },
      );
    } finally {
      registration();
    }
    // 'Could not enumerate' is not 'empty': nothing may be diffed off a
    // snapshot that could not be taken.
    expect(seen).toEqual([]);
  });

  it.skipIf(noPosixPermissions)(
    'does not create a phantom event when an outside notify cannot read the file',
    async () => {
      const projectRoot = await setup();
      const file = path.join(tempDir!, 'memories', 'user', 'jammed.md');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'same\n');
      const windowSeen: MemoryChangedNotice[] = [];
      const writerRegistration = registerMemoryChangedListener(
        projectRoot,
        () => {},
      );
      const windowRegistration = registerMemoryChangedListener(
        projectRoot,
        (change) => {
          windowSeen.push(change);
        },
      );
      let windowOpened: () => void = () => {};
      const opened = new Promise<void>((resolve) => {
        windowOpened = resolve;
      });
      let outsideDone: () => void = () => {};
      const outsideReported = new Promise<void>((resolve) => {
        outsideDone = resolve;
      });
      try {
        const pending = withCoalescedMemoryChanges(
          projectRoot,
          windowRegistration.id,
          async () => {
            windowOpened();
            await outsideReported;
          },
        );
        // The window has taken its before-snapshot once fn starts.
        await opened;
        // The outside notify cannot read the file (a transient EACCES); the
        // file is still there, unchanged, when the window closes.
        await fs.chmod(file, 0o000);
        await notifyMemoryFileChange(
          file,
          projectRoot,
          'update',
          writerRegistration.id,
        );
        await fs.chmod(file, 0o644);
        outsideDone();
        await pending;
      } finally {
        await fs.chmod(file, 0o644).catch(() => undefined);
        writerRegistration();
        windowRegistration();
      }
      // A transiently unreadable file is unknown, not absent: the window must
      // not diff it as created against a moved-to-null baseline.
      expect(windowSeen).toEqual([]);
    },
  );

  it('delivers a team index rebuild to the writing registration', async () => {
    const projectRoot = await setup();
    // Anchor the team root deterministically inside the temp repo.
    await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });
    const teamRoot = getTeamAutoMemoryRoot(projectRoot);
    await fs.mkdir(teamRoot, { recursive: true });
    const first: MemoryChangedNotice[] = [];
    const second: MemoryChangedNotice[] = [];
    const firstRegistration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        first.push(change);
      },
    );
    const secondRegistration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        second.push(change);
      },
    );
    try {
      await rebuildTeamAutoMemoryIndex(projectRoot, {
        deliveryId: firstRegistration.id,
      });
    } finally {
      firstRegistration();
      secondRegistration();
    }
    expect(first).toEqual([
      expect.objectContaining({
        scope: 'team',
        operation: 'create',
        relativePaths: ['MEMORY.md'],
      }),
    ]);
    expect(second).toEqual([]);
  });

  it.skipIf(noPosixPermissions)(
    'labels an existing but unreadable index as update, not create',
    async () => {
      const projectRoot = await setup();
      const indexPath = getUserAutoMemoryIndexPath();
      await fs.mkdir(path.dirname(indexPath), { recursive: true });
      await fs.writeFile(indexPath, 'stale\n');
      const seen: MemoryChangedNotice[] = [];
      const registration = registerMemoryChangedListener(
        projectRoot,
        (change) => {
          seen.push(change);
        },
      );
      await fs.chmod(indexPath, 0o000);
      try {
        await rebuildUserAutoMemoryIndex(projectRoot);
      } finally {
        await fs.chmod(indexPath, 0o644).catch(() => undefined);
        registration();
      }
      expect(seen).toEqual([
        expect.objectContaining({
          operation: 'update',
          relativePaths: ['MEMORY.md'],
        }),
      ]);
    },
  );

  it.each([
    {
      name: 'reports a window delete of a path an outside write created',
      before: undefined,
      outside: 'create' as const,
      window: 'rm' as const,
      expected: 'delete',
    },
    {
      name: 'reports a window re-create of a path an outside write deleted',
      before: 'old\n',
      outside: 'delete' as const,
      window: 'write' as const,
      expected: 'create',
    },
  ])('$name', async ({ before, outside, window, expected }) => {
    const projectRoot = await setup();
    const file = path.join(tempDir!, 'memories', 'user', 'shared.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (before !== undefined) await fs.writeFile(file, before);
    const windowSeen: MemoryChangedNotice[] = [];
    const writerRegistration = registerMemoryChangedListener(
      projectRoot,
      () => {},
    );
    const windowRegistration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        windowSeen.push(change);
      },
    );
    let windowOpened: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      windowOpened = resolve;
    });
    let outsideDone: () => void = () => {};
    const outsideReported = new Promise<void>((resolve) => {
      outsideDone = resolve;
    });
    try {
      const pending = withCoalescedMemoryChanges(
        projectRoot,
        windowRegistration.id,
        async () => {
          windowOpened();
          await outsideReported;
          if (window === 'rm') await fs.rm(file);
          else await fs.writeFile(file, 'back\n');
        },
      );
      // The window has taken its snapshot before the outside write lands.
      await opened;
      if (outside === 'delete') await fs.rm(file);
      else await fs.writeFile(file, 'out\n');
      await notifyMemoryFileChange(
        file,
        projectRoot,
        outside,
        writerRegistration.id,
      );
      outsideDone();
      await pending;
    } finally {
      writerRegistration();
      windowRegistration();
    }
    expect(windowSeen).toEqual([
      expect.objectContaining({
        operation: expected,
        relativePaths: ['user/shared.md'],
      }),
    ]);
  });

  it('reports a window change when the window body fails', async () => {
    const projectRoot = await setup();
    const file = path.join(tempDir!, 'memories', 'user', 'partial.md');
    const seen: MemoryChangedNotice[] = [];
    const registration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        seen.push(change);
      },
    );
    const sentinel = new Error('agent aborted');
    try {
      await expect(
        withCoalescedMemoryChanges(projectRoot, registration.id, async () => {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, 'partial\n');
          throw sentinel;
        }),
      ).rejects.toBe(sentinel);
    } finally {
      registration();
    }
    // The finally still diffs and reports what the failed run wrote.
    expect(seen).toEqual([
      expect.objectContaining({
        operation: 'create',
        relativePaths: ['user/partial.md'],
      }),
    ]);
  });

  it('ignores non-document files in the coalesced window diff', async () => {
    const projectRoot = await setup();
    const userRoot = path.join(tempDir!, 'memories');
    // An atomicWriteFile temp sibling and macOS junk, present at both
    // snapshots' time but never memory documents.
    const tmpSibling = path.join(
      userRoot,
      'user',
      'MEMORY.md.deadbeef0000.tmp',
    );
    const junk = path.join(userRoot, 'user', '.DS_Store');
    await fs.mkdir(path.dirname(tmpSibling), { recursive: true });
    await fs.writeFile(tmpSibling, 'partial\n');
    await fs.writeFile(junk, 'junk\n');
    const seen: MemoryChangedNotice[] = [];
    const registration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        seen.push(change);
      },
    );
    try {
      await withCoalescedMemoryChanges(
        projectRoot,
        registration.id,
        async () => {
          await fs.rm(tmpSibling);
          await fs.rm(junk);
        },
      );
    } finally {
      registration();
    }
    expect(seen).toEqual([]);
  });

  it.skipIf(noPosixPermissions)(
    'labels a document unreadable only at window open as update, not create',
    async () => {
      const projectRoot = await setup();
      const file = path.join(tempDir!, 'memories', 'user', 'old.md');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'same\n');
      // Unreadable when the window opens, readable again before it closes.
      await fs.chmod(file, 0o000);
      const seen: MemoryChangedNotice[] = [];
      const registration = registerMemoryChangedListener(
        projectRoot,
        (change) => {
          seen.push(change);
        },
      );
      try {
        await withCoalescedMemoryChanges(
          projectRoot,
          registration.id,
          async () => {
            await fs.chmod(file, 0o644);
          },
        );
      } finally {
        await fs.chmod(file, 0o644).catch(() => undefined);
        registration();
      }
      // The document existed (unreadable) before the window:
      // unknown-before is not absent-before, so this is an update.
      expect(seen).toEqual([
        expect.objectContaining({
          operation: 'update',
          relativePaths: ['user/old.md'],
        }),
      ]);
    },
  );

  it.skipIf(noPosixPermissions)(
    'reports a delete for a document that was unreadable at window open',
    async () => {
      const projectRoot = await setup();
      const file = path.join(tempDir!, 'memories', 'user', 'stuck.md');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'locked\n');
      await fs.chmod(file, 0o000);
      const seen: MemoryChangedNotice[] = [];
      const registration = registerMemoryChangedListener(
        projectRoot,
        (change) => {
          seen.push(change);
        },
      );
      try {
        await withCoalescedMemoryChanges(
          projectRoot,
          registration.id,
          async () => {
            // unlink needs write on the directory, not the file, so the
            // delete works even while the document itself is unreadable.
            await fs.rm(file);
          },
        );
      } finally {
        await fs.chmod(file, 0o644).catch(() => undefined);
        registration();
      }
      // Present-but-unreadable at open, gone at close is a delete: the
      // document was on disk and no longer is.
      expect(seen).toEqual([
        expect.objectContaining({
          operation: 'delete',
          relativePaths: ['user/stuck.md'],
        }),
      ]);
    },
  );

  it.skipIf(noSymlinks)(
    'does not turn a sibling write behind a symlinked directory into a window delete',
    async () => {
      const projectRoot = await setup();
      const vaultDir = path.join(tempDir!, 'vault');
      await fs.mkdir(vaultDir, { recursive: true });
      await fs.writeFile(path.join(vaultDir, 'role.md'), 'v1\n');
      const memoriesRoot = path.join(tempDir!, 'memories');
      await fs.mkdir(memoriesRoot, { recursive: true });
      // The symlink sits one level up from the document: the tree walk
      // recurses only into real directories, so the path behind it is
      // invisible to every window.
      await fs.symlink(vaultDir, path.join(memoriesRoot, 'linked'));
      const writerSeen: MemoryChangedNotice[] = [];
      const windowSeen: MemoryChangedNotice[] = [];
      const writerRegistration = registerMemoryChangedListener(
        projectRoot,
        (change) => {
          writerSeen.push(change);
        },
      );
      const windowRegistration = registerMemoryChangedListener(
        projectRoot,
        (change) => {
          windowSeen.push(change);
        },
      );
      let outsideDone: () => void = () => {};
      const outsideReported = new Promise<void>((resolve) => {
        outsideDone = resolve;
      });
      try {
        const pending = withCoalescedMemoryChanges(
          projectRoot,
          windowRegistration.id,
          () => outsideReported,
        );
        const linkedFile = path.join(memoriesRoot, 'linked', 'role.md');
        await fs.writeFile(linkedFile, 'v2\n');
        await notifyMemoryFileChange(
          linkedFile,
          projectRoot,
          'update',
          writerRegistration.id,
        );
        outsideDone();
        await pending;
      } finally {
        writerRegistration();
        windowRegistration();
      }
      // The walk cannot see the path, so the window must not turn the
      // recorded outside write into a `delete` for a file still on disk.
      expect(windowSeen).toEqual([]);
      expect(writerSeen).toEqual([
        expect.objectContaining({
          operation: 'update',
          relativePaths: ['linked/role.md'],
        }),
      ]);
    },
  );

  it.skipIf(noSymlinks)(
    'still emits a window write that lands behind a symlinked directory',
    async () => {
      const projectRoot = await setup();
      const vaultDir = path.join(tempDir!, 'vault');
      await fs.mkdir(vaultDir, { recursive: true });
      const memoriesRoot = path.join(tempDir!, 'memories');
      await fs.mkdir(memoriesRoot, { recursive: true });
      await fs.symlink(vaultDir, path.join(memoriesRoot, 'linked'));
      const seen: MemoryChangedNotice[] = [];
      const registration = registerMemoryChangedListener(
        projectRoot,
        (change) => {
          seen.push(change);
        },
      );
      try {
        await withCoalescedMemoryChanges(
          projectRoot,
          registration.id,
          async () => {
            const linkedFile = path.join(memoriesRoot, 'linked', 'role.md');
            await fs.writeFile(linkedFile, 'v1\n');
            // The closing diff can never see this path; the write must be
            // delivered directly instead of swallowed with the window.
            await notifyMemoryFileChange(
              linkedFile,
              projectRoot,
              'create',
              registration.id,
            );
          },
        );
      } finally {
        registration();
      }
      expect(seen).toEqual([
        expect.objectContaining({
          operation: 'create',
          relativePaths: ['linked/role.md'],
        }),
      ]);
    },
  );

  it('delivers the caller abort signal to listeners', async () => {
    const projectRoot = await setup();
    const file = path.join(tempDir!, 'memories', 'user', 'role.md');
    const seen: Array<AbortSignal | undefined> = [];
    const registration = registerMemoryChangedListener(
      projectRoot,
      (_change, signal) => {
        seen.push(signal);
      },
    );
    const controller = new AbortController();
    try {
      await notifyMemoryFileChange(
        file,
        projectRoot,
        'update',
        registration.id,
        controller.signal,
      );
    } finally {
      registration();
    }
    expect(seen).toEqual([controller.signal]);
  });

  it('labels the first rebuild of a scaffold-created empty index as create', async () => {
    const projectRoot = await setup();
    // ensureAutoMemoryScaffold plants an EMPTY MEMORY.md without notifying;
    // the first contentful rebuild must announce a create, not an update for
    // a document the consumer was never told existed.
    const userRoot = getUserAutoMemoryRoot();
    await fs.mkdir(path.join(userRoot, 'user'), { recursive: true });
    await fs.writeFile(getUserAutoMemoryIndexPath(), '');
    await fs.writeFile(
      path.join(userRoot, 'user', 'role.md'),
      [
        '---',
        'name: role',
        'description: User is a Go engineer.',
        'type: user',
        '---',
        '',
        'User has been writing Go for 10 years.',
        '',
      ].join('\n'),
    );
    const seen: MemoryChangedNotice[] = [];
    const registration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        seen.push(change);
      },
    );
    try {
      await rebuildUserAutoMemoryIndex(projectRoot);
    } finally {
      registration();
    }
    expect(seen).toEqual([
      expect.objectContaining({
        scope: 'user',
        operation: 'create',
        relativePaths: ['MEMORY.md'],
      }),
    ]);
  });

  it('reports a file removed inside a coalesced window once', async () => {
    const projectRoot = await setup();
    const file = path.join(tempDir!, 'memories', 'user', 'gone.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'old\n');
    const seen: MemoryChangedNotice[] = [];
    const registration = registerMemoryChangedListener(
      projectRoot,
      (change) => {
        seen.push(change);
      },
    );
    try {
      await withCoalescedMemoryChanges(
        projectRoot,
        registration.id,
        async () => {
          await notifyMemoryFileChange(
            file,
            projectRoot,
            'delete',
            registration.id,
          );
          await fs.rm(file);
        },
      );
    } finally {
      registration();
    }
    expect(seen).toEqual([
      expect.objectContaining({
        operation: 'delete',
        relativePaths: ['user/gone.md'],
      }),
    ]);
  });
});
