/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { clearAutoMemoryRootCache } from '../memory/paths.js';
import { WorkspaceContext } from '../utils/workspaceContext.js';
import { getFileReadDefaultPermission } from './file-read-permission.js';

const skipOnWindows = process.platform === 'win32';

/**
 * Layout built once for the whole suite. The temp base is realpath'd up front
 * so assertions do not depend on macOS resolving `/var` to `/private/var`
 * partway through a comparison.
 */
interface Layout {
  base: string;
  workspace: string;
  projectTempDir: string;
  projectDir: string;
  globalTempDir: string;
  userSkillsDir: string;
  userExtensionsDir: string;
  plansDir: string;
  userWorkflowsDir: string;
  workflowRunsDir: string;
  memoryBaseDir: string;
  /** Outside the workspace and outside every allow-listed root. */
  secretsDir: string;
  secretFile: string;
}

let layout: Layout;
let originalMemoryBaseDir: string | undefined;

function makeConfig(overrides: { plansDir?: string } = {}): Config {
  const workspaceContext = new WorkspaceContext(layout.workspace);
  return {
    getWorkspaceContext: () => workspaceContext,
    getTargetDir: () => layout.workspace,
    getPlansDir: () => overrides.plansDir ?? layout.plansDir,
    storage: {
      getProjectTempDir: () => layout.projectTempDir,
      getProjectDir: () => layout.projectDir,
      getWorkflowRunsDir: () => layout.workflowRunsDir,
      getUserSkillsDirs: () => [layout.userSkillsDir],
    },
  } as unknown as Config;
}

function permissionFor(requestedPath: string) {
  return getFileReadDefaultPermission(makeConfig(), requestedPath);
}

beforeAll(() => {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-file-read-perm-')),
  );
  layout = {
    base,
    workspace: path.join(base, 'workspace'),
    projectTempDir: path.join(base, 'runtime', 'projects', 'p1', 'tmp'),
    projectDir: path.join(base, 'runtime', 'projects', 'p1'),
    globalTempDir: path.join(base, 'runtime', 'tmp'),
    userSkillsDir: path.join(base, 'runtime', 'skills'),
    userExtensionsDir: path.join(base, 'runtime', 'extensions'),
    plansDir: path.join(base, 'runtime', 'plans'),
    userWorkflowsDir: path.join(base, 'home', '.qwen', 'workflows'),
    workflowRunsDir: path.join(base, 'runtime', 'workflow-runs-sentinel'),
    memoryBaseDir: path.join(base, 'runtime', 'memory-base'),
    secretsDir: path.join(base, 'secrets'),
    secretFile: path.join(base, 'secrets', 'credentials'),
  };

  for (const dir of [
    layout.workspace,
    layout.projectTempDir,
    path.join(layout.projectDir, 'subagents'),
    layout.globalTempDir,
    layout.userSkillsDir,
    layout.userExtensionsDir,
    layout.plansDir,
    layout.userWorkflowsDir,
    layout.workflowRunsDir,
    layout.memoryBaseDir,
    layout.secretsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(layout.secretFile, 'SENTINEL-SECRET', 'utf8');

  // Keep the auto-memory branch hermetic: point it at an empty temp base so no
  // candidate below can accidentally land inside a real ~/.qwen/memories.
  originalMemoryBaseDir = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  process.env['QWEN_CODE_MEMORY_BASE_DIR'] = layout.memoryBaseDir;
  clearAutoMemoryRootCache();
});

afterAll(() => {
  if (originalMemoryBaseDir === undefined) {
    delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  } else {
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = originalMemoryBaseDir;
  }
  clearAutoMemoryRootCache();
  fs.rmSync(layout.base, { recursive: true, force: true });
});

beforeEach(() => {
  vi.spyOn(Storage, 'getGlobalTempDir').mockReturnValue(layout.globalTempDir);
  vi.spyOn(Storage, 'getUserExtensionsDir').mockReturnValue(
    layout.userExtensionsDir,
  );
  vi.spyOn(Storage, 'getUserWorkflowsDir').mockReturnValue(
    layout.userWorkflowsDir,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getFileReadDefaultPermission', () => {
  describe('baseline containment', () => {
    it('allows a real file inside the workspace', () => {
      const file = path.join(layout.workspace, 'src.ts');
      fs.writeFileSync(file, 'x', 'utf8');
      expect(permissionFor(file)).toBe('allow');
    });

    it('allows a real file inside an allow-listed root', () => {
      const file = path.join(layout.projectTempDir, 'scratch.txt');
      fs.writeFileSync(file, 'x', 'utf8');
      expect(permissionFor(file)).toBe('allow');
    });

    it('allows a not-yet-created file under a real allow-listed root', () => {
      // The nearest-existing walk must not downgrade a legitimate root just
      // because the leaf is absent — write/edit pre-reads hit this constantly.
      expect(
        permissionFor(path.join(layout.projectTempDir, 'absent.txt')),
      ).toBe('allow');
    });

    // Every workflow result and completion notification names a path under
    // the run dir — the resume journal above all — so reading one back must
    // not stall on a confirmation prompt the model cannot answer.
    it('allows a workflow run journal', () => {
      const journal = path.join(
        layout.workflowRunsDir,
        'wf_1234abcd',
        'journal.jsonl',
      );
      fs.mkdirSync(path.dirname(journal), { recursive: true });
      fs.writeFileSync(journal, '{}\n', 'utf8');
      expect(permissionFor(journal)).toBe('allow');
    });

    it('allows a persisted inline workflow script', () => {
      const script = path.join(
        layout.workflowRunsDir,
        'generated',
        'inline',
        'wf_1234abcd.js',
      );
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, 'return 1;', 'utf8');
      expect(permissionFor(script)).toBe('allow');
    });

    it('allows a user-scope saved workflow script', () => {
      const script = path.join(layout.userWorkflowsDir, 'triage.js');
      fs.writeFileSync(script, 'return 1;', 'utf8');
      expect(permissionFor(script)).toBe('allow');
    });

    it('asks for a plain file outside every root', () => {
      expect(permissionFor(layout.secretFile)).toBe('ask');
    });

    it('asks for a missing file outside every root', () => {
      expect(permissionFor(path.join(layout.secretsDir, 'absent'))).toBe('ask');
    });
  });

  // The regression this suite exists for. A lexical `path.resolve` classifies
  // a symlink by where it SITS, and every root below is agent-writable — so
  // the old check handed out a silent `allow` for any file on the host, with
  // no confirmation prompt at all.
  describe.skipIf(skipOnWindows)(
    'symlinks planted inside an allow-listed root',
    () => {
      const roots: Array<[string, () => string]> = [
        ['project-temp-dir', () => layout.projectTempDir],
        ['subagents-dir', () => path.join(layout.projectDir, 'subagents')],
        ['global-temp-dir', () => layout.globalTempDir],
        ['user-skills-dir', () => layout.userSkillsDir],
        ['user-extensions-dir', () => layout.userExtensionsDir],
        ['plans-dir', () => layout.plansDir],
        ['user-workflows-dir', () => layout.userWorkflowsDir],
        ['workflow-runs-dir', () => layout.workflowRunsDir],
      ];

      it.each(roots)('asks for a file symlink under the %s', (name, root) => {
        const link = path.join(root(), `escape-${name}`);
        fs.symlinkSync(layout.secretFile, link);
        expect(permissionFor(link)).toBe('ask');
      });

      it('asks when a directory symlink is traversed', () => {
        const link = path.join(layout.globalTempDir, 'dirlink');
        fs.symlinkSync(layout.secretsDir, link, 'dir');
        expect(permissionFor(path.join(link, 'credentials'))).toBe('ask');
      });

      it('asks for a dangling symlink whose target is outside', () => {
        // fs.existsSync() follows links and reports a dangling one as missing,
        // so a naive nearest-existing walk would stop at the root and allow it.
        const link = path.join(layout.plansDir, 'dangling');
        fs.symlinkSync(path.join(layout.secretsDir, 'not-yet-created'), link);
        expect(permissionFor(link)).toBe('ask');
      });

      it('asks for a not-yet-created file behind an escaping dir symlink', () => {
        const realNested = path.join(layout.base, 'real-nested');
        fs.mkdirSync(realNested, { recursive: true });
        const link = path.join(layout.globalTempDir, 'nested');
        fs.symlinkSync(realNested, link, 'dir');
        expect(permissionFor(path.join(link, 'new.txt'))).toBe('ask');
      });
    },
  );

  describe.skipIf(skipOnWindows)(
    'symlinked roots still match, because both sides are canonicalized',
    () => {
      it('allows a file reached through a symlinked allow-listed root', () => {
        const realRoot = path.join(layout.base, 'real-plans');
        fs.mkdirSync(realRoot, { recursive: true });
        const file = path.join(realRoot, 'plan.md');
        fs.writeFileSync(file, 'x', 'utf8');

        const linkedPlans = path.join(layout.base, 'linked-plans');
        fs.symlinkSync(realRoot, linkedPlans, 'dir');
        const config = makeConfig({ plansDir: linkedPlans });

        // Requested by real path while the configured root is the symlink.
        expect(getFileReadDefaultPermission(config, file)).toBe('allow');
        // ...and by the symlink while the file resolves to the real path.
        expect(
          getFileReadDefaultPermission(
            config,
            path.join(linkedPlans, 'plan.md'),
          ),
        ).toBe('allow');
      });
    },
  );
});
