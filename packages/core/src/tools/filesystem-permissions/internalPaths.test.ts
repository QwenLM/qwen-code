/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { posix } from 'node:path';
import {
  INTERNAL_DIR_NAME,
  isProjectInternalPath,
  isProjectDirPath,
  isProjectTempPath,
  isIsolatedTaskOutput,
  isPastedImagePath,
  isInboundUploadPath,
  isUserConfigPath,
  isSessionPlanFile,
  checkReadableInternalPath,
  checkEditableInternalPath,
} from './internalPaths.js';
import { homedir } from 'node:os';
import { ENV_PRODUCT_HOME, BRAND_CLI_SLUG } from '../../config/brand.js';
import { sanitizePath } from '../../utils/paths.js';
import {
  qwenInternalPathDeps,
  type InternalPathContext,
} from './internal-path-deps.js';
import { computeIsolatedTaskOutputDir } from '../../utils/task/diskOutput.js';

const cwd = '/project';
const D = INTERNAL_DIR_NAME; // ".qwen" (or branded equivalent)

describe('internalPaths · isProjectInternalPath', () => {
  it('allows todo.md under <cwd>/.qwen/', () => {
    expect(
      isProjectInternalPath(`/project/${D}/todo.md`, cwd, contextFor()),
    ).toBe(true);
  });

  it('allows files under memory/ subdirectory', () => {
    expect(
      isProjectInternalPath(
        `/project/${D}/memory/auto/MEMORY.md`,
        cwd,
        contextFor(),
      ),
    ).toBe(true);
  });

  it('allows settings.json', () => {
    expect(
      isProjectInternalPath(`/project/${D}/settings.json`, cwd, contextFor()),
    ).toBe(true);
  });

  it('allows settings.local.json', () => {
    expect(
      isProjectInternalPath(
        `/project/${D}/settings.local.json`,
        cwd,
        contextFor(),
      ),
    ).toBe(true);
  });

  it('rejects unlisted files (e.g. hooks.json)', () => {
    expect(
      isProjectInternalPath(`/project/${D}/hooks.json`, cwd, contextFor()),
    ).toBe(false);
  });

  it('rejects nested files masquerading as settings.json (path traversal guard)', () => {
    expect(
      isProjectInternalPath(
        `/project/${D}/settings.json/malicious.sh`,
        cwd,
        contextFor(),
      ),
    ).toBe(false);
  });

  it('rejects paths under a different project root', () => {
    expect(
      isProjectInternalPath(
        `/other/project/${D}/settings.json`,
        cwd,
        contextFor(),
      ),
    ).toBe(false);
  });

  it('matches case-insensitively (case-insensitive FS bypass guard)', () => {
    expect(
      isProjectInternalPath(`/project/${D}/Settings.JSON`, cwd, contextFor()),
    ).toBe(true);
    expect(
      isProjectInternalPath(
        `/project/${D}/SETTINGS.LOCAL.JSON`,
        cwd,
        contextFor(),
      ),
    ).toBe(true);
  });

  it('rejects absolute paths outside any .qwen/ prefix', () => {
    expect(isProjectInternalPath('/etc/passwd', cwd, contextFor())).toBe(false);
    expect(
      isProjectInternalPath('/project/src/main.ts', cwd, contextFor()),
    ).toBe(false);
  });

  it('handles cwd with trailing slash identically', () => {
    expect(
      isProjectInternalPath(`/project/${D}/todo.md`, '/project/', contextFor()),
    ).toBe(true);
  });
});

describe('internalPaths · checkReadableInternalPath', () => {
  it('returns true for any project-internal path (sub-domain delegation)', () => {
    expect(
      checkReadableInternalPath(`/project/${D}/todo.md`, cwd, contextFor()),
    ).toBe(true);
    expect(
      checkReadableInternalPath(`/project/${D}/memory/x.md`, cwd, contextFor()),
    ).toBe(true);
  });

  it('returns false for non-internal paths', () => {
    expect(
      checkReadableInternalPath('/project/src/main.ts', cwd, contextFor()),
    ).toBe(false);
    expect(checkReadableInternalPath('/etc/passwd', cwd, contextFor())).toBe(
      false,
    );
  });

  it('accepts optional ctx without breaking', () => {
    expect(
      checkReadableInternalPath(
        `/project/${D}/todo.md`,
        cwd,
        contextFor('sid-123'),
      ),
    ).toBe(true);
  });
});

describe('internalPaths · checkEditableInternalPath', () => {
  it('returns true for project-internal writable paths', () => {
    expect(
      checkEditableInternalPath(`/project/${D}/todo.md`, cwd, contextFor()),
    ).toBe(true);
  });

  it('excludes project settings files from the write fast path', () => {
    expect(
      checkEditableInternalPath(
        `/project/${D}/settings.json`,
        cwd,
        contextFor(),
      ),
    ).toBe(false);
    expect(
      checkEditableInternalPath(
        `/project/${D}/Settings.Local.JSON`,
        cwd,
        contextFor(),
      ),
    ).toBe(false);
    expect(
      checkReadableInternalPath(
        `/project/${D}/settings.json`,
        cwd,
        contextFor(),
      ),
    ).toBe(true);
  });

  it('returns false for non-internal paths', () => {
    expect(
      checkEditableInternalPath('/project/src/main.ts', cwd, contextFor()),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// isProjectDirPath · ~/.qwen/projects/{sanitized-cwd}/...
// ─────────────────────────────────────────────────────────────────────────

describe('internalPaths · isProjectDirPath', () => {
  // Build the canonical project-dir prefix the same way internalPaths does.
  // Use posix joins so the test is platform-agnostic.
  const projectId = sanitizePath(cwd);
  const projectDirPrefix = posix.join(
    getConfigHomeDir().replace(/\\/g, '/'),
    'projects',
    projectId,
  );

  it('allows files directly under ~/.qwen/projects/{id}/', () => {
    const p = `${projectDirPrefix}/memory/auto/MEMORY.md`;
    expect(isProjectDirPath(p, cwd, contextFor())).toBe(true);
  });

  it('allows arbitrary nested files (cross-session storage subtree)', () => {
    const p = `${projectDirPrefix}/cache/2026-06/snapshot.json`;
    expect(isProjectDirPath(p, cwd, contextFor())).toBe(true);
  });

  it('matches case-insensitively (case-insensitive FS bypass guard)', () => {
    const p = `${projectDirPrefix}/Memory/AUTO/MEMORY.md`.toUpperCase();
    expect(isProjectDirPath(p, cwd, contextFor())).toBe(true);
  });

  it('rejects paths outside the project-dir prefix', () => {
    expect(isProjectDirPath('/project/src/main.ts', cwd, contextFor())).toBe(
      false,
    );
    expect(isProjectDirPath('/etc/passwd', cwd, contextFor())).toBe(false);
  });

  it('rejects sibling project ids (sanitize-based isolation)', () => {
    // Different cwd → different sanitized id → different prefix.
    const otherCwd = '/other-project';
    const otherId = sanitizePath(otherCwd);
    const p = posix.join(
      getConfigHomeDir().replace(/\\/g, '/'),
      'projects',
      otherId,
      'memory/x.md',
    );
    expect(isProjectDirPath(p, cwd, contextFor())).toBe(false);
  });

  it('rejects the projects/ root itself (must be inside a project id)', () => {
    const p = posix.join(getConfigHomeDir().replace(/\\/g, '/'), 'projects');
    expect(isProjectDirPath(p, cwd, contextFor())).toBe(false);
  });
});

describe('internalPaths · checkReadableInternalPath · project-dir', () => {
  const projectId = sanitizePath(cwd);
  const projectDirPrefix = posix.join(
    getConfigHomeDir().replace(/\\/g, '/'),
    'projects',
    projectId,
  );

  it('treats project-dir paths as readable internal paths', () => {
    expect(
      checkReadableInternalPath(
        `${projectDirPrefix}/memory/x.md`,
        cwd,
        contextFor(),
      ),
    ).toBe(true);
  });

  it('treats project-dir paths as editable internal paths', () => {
    expect(
      checkEditableInternalPath(
        `${projectDirPrefix}/memory/x.md`,
        cwd,
        contextFor(),
      ),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// isProjectTempPath · ~/.qwen/tmp/{sanitized-cwd}/...
// ─────────────────────────────────────────────────────────────────────────

describe('internalPaths · isProjectTempPath', () => {
  const projectId = sanitizePath(cwd);
  const projectTempPrefix = posix.join(
    getConfigHomeDir().replace(/\\/g, '/'),
    'tmp',
    projectId,
  );

  it('allows session-scoped plans subtree', () => {
    expect(
      isProjectTempPath(
        `${projectTempPrefix}/sid-1/plans/draft.md`,
        cwd,
        contextFor(),
      ),
    ).toBe(true);
  });

  it('allows tasks / logs / shell_history under tmp', () => {
    expect(
      isProjectTempPath(
        `${projectTempPrefix}/sid-1/tasks/abc.output`,
        cwd,
        contextFor(),
      ),
    ).toBe(true);
    expect(
      isProjectTempPath(`${projectTempPrefix}/logs/run.log`, cwd, contextFor()),
    ).toBe(true);
    expect(
      isProjectTempPath(
        `${projectTempPrefix}/shell_history`,
        cwd,
        contextFor(),
      ),
    ).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(
      isProjectTempPath(
        `${projectTempPrefix}/SID-1/PLANS/X.md`.toUpperCase(),
        cwd,
        contextFor(),
      ),
    ).toBe(true);
  });

  it('rejects paths outside the tmp prefix', () => {
    expect(isProjectTempPath('/etc/passwd', cwd, contextFor())).toBe(false);
    expect(isProjectTempPath('/project/src/main.ts', cwd, contextFor())).toBe(
      false,
    );
  });

  it('rejects sibling project tmp dirs (sanitize-based isolation)', () => {
    const otherCwd = '/other-project';
    const otherId = sanitizePath(otherCwd);
    const p = posix.join(
      getConfigHomeDir().replace(/\\/g, '/'),
      'tmp',
      otherId,
      'sid-1/x.md',
    );
    expect(isProjectTempPath(p, cwd, contextFor())).toBe(false);
  });

  it('rejects ~/.qwen/projects/ paths (only ~/.qwen/tmp/ matches)', () => {
    const projectsPrefix = posix.join(
      getConfigHomeDir().replace(/\\/g, '/'),
      'projects',
      projectId,
    );
    expect(
      isProjectTempPath(`${projectsPrefix}/memory/x.md`, cwd, contextFor()),
    ).toBe(false);
  });
});

describe('internalPaths · checkReadable/EditableInternalPath · project-temp', () => {
  const projectId = sanitizePath(cwd);
  const projectTempPrefix = posix.join(
    getConfigHomeDir().replace(/\\/g, '/'),
    'tmp',
    projectId,
  );

  it('treats project-temp paths as readable & editable', () => {
    const p = `${projectTempPrefix}/sid-1/plans/draft.md`;
    expect(checkReadableInternalPath(p, cwd, contextFor())).toBe(true);
    expect(checkEditableInternalPath(p, cwd, contextFor())).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// isIsolatedTaskOutput · {tmpdir}/qwen-{uid}/{id}/{sid}/tasks/...
// ─────────────────────────────────────────────────────────────────────────

describe('internalPaths · isIsolatedTaskOutput', () => {
  const sessionId = 'sid-abc';
  const ctx = contextFor(sessionId);
  const projectId = sanitizePath(cwd);
  const taskOutDir = computeIsolatedTaskOutputDir(projectId, sessionId).replace(
    /\\/g,
    '/',
  );

  it('allows .output files in current session task dir', () => {
    expect(isIsolatedTaskOutput(`${taskOutDir}/abc.output`, cwd, ctx)).toBe(
      true,
    );
  });

  it('allows arbitrary nested files under current session task dir', () => {
    expect(
      isIsolatedTaskOutput(`${taskOutDir}/sub/nested.json`, cwd, ctx),
    ).toBe(true);
  });

  it('rejects when ctx is missing or sessionId is undefined', () => {
    expect(isIsolatedTaskOutput(`${taskOutDir}/abc.output`, cwd)).toBe(false);
    expect(isIsolatedTaskOutput(`${taskOutDir}/abc.output`, cwd, {})).toBe(
      false,
    );
  });

  it('rejects task output from a different session (cross-session isolation)', () => {
    const otherDir = computeIsolatedTaskOutputDir(
      projectId,
      'sid-other',
    ).replace(/\\/g, '/');
    expect(isIsolatedTaskOutput(`${otherDir}/abc.output`, cwd, ctx)).toBe(
      false,
    );
  });

  it('rejects task output from a different project (cross-project isolation)', () => {
    const otherDir = computeIsolatedTaskOutputDir(
      sanitizePath('/other-project'),
      sessionId,
    ).replace(/\\/g, '/');
    expect(isIsolatedTaskOutput(`${otherDir}/abc.output`, cwd, ctx)).toBe(
      false,
    );
  });

  it('rejects unrelated tmp paths', () => {
    expect(isIsolatedTaskOutput('/tmp/random.txt', cwd, ctx)).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(
      isIsolatedTaskOutput(`${taskOutDir}/ABC.OUTPUT`.toUpperCase(), cwd, ctx),
    ).toBe(true);
  });
});

describe('internalPaths · checkReadable/EditableInternalPath · isolated-task-output', () => {
  const sessionId = 'sid-abc';
  const ctx = contextFor(sessionId);
  const projectId = sanitizePath(cwd);
  const taskOutDir = computeIsolatedTaskOutputDir(projectId, sessionId).replace(
    /\\/g,
    '/',
  );

  it('treats isolated-task-output paths as readable & editable when ctx is provided', () => {
    const p = `${taskOutDir}/abc.output`;
    expect(checkReadableInternalPath(p, cwd, ctx)).toBe(true);
    expect(checkEditableInternalPath(p, cwd, ctx)).toBe(true);
  });

  it('falls back to other sub-domains (or false) without ctx', () => {
    const p = `${taskOutDir}/abc.output`;
    expect(checkReadableInternalPath(p, cwd, contextFor())).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// isPastedImagePath · ~/.qwen/tmp/{id}/images/{sid}/...
// ─────────────────────────────────────────────────────────────────────────

describe('internalPaths · isPastedImagePath', () => {
  const sessionId = 'sid-abc';
  const ctx = contextFor(sessionId);
  const projectId = sanitizePath(cwd);
  const imagesDir = posix.join(
    getConfigHomeDir().replace(/\\/g, '/'),
    'tmp',
    projectId,
    'images',
    sessionId,
  );

  it('allows pasted image files in current session images dir', () => {
    expect(isPastedImagePath(`${imagesDir}/12-clip.png`, cwd, ctx)).toBe(true);
  });

  it('allows files with various image extensions', () => {
    expect(isPastedImagePath(`${imagesDir}/3-shot.jpg`, cwd, ctx)).toBe(true);
    expect(isPastedImagePath(`${imagesDir}/0-img.webp`, cwd, ctx)).toBe(true);
  });

  it('rejects when ctx.sessionId is missing', () => {
    expect(isPastedImagePath(`${imagesDir}/12-clip.png`, cwd)).toBe(false);
    expect(isPastedImagePath(`${imagesDir}/12-clip.png`, cwd, {})).toBe(false);
  });

  it('rejects images from a different session (cross-session isolation)', () => {
    const otherDir = posix.join(
      getConfigHomeDir().replace(/\\/g, '/'),
      'tmp',
      projectId,
      'images',
      'sid-other',
    );
    expect(isPastedImagePath(`${otherDir}/12-clip.png`, cwd, ctx)).toBe(false);
  });

  it('rejects images from a different project', () => {
    const otherProjectImages = posix.join(
      getConfigHomeDir().replace(/\\/g, '/'),
      'tmp',
      sanitizePath('/other-project'),
      'images',
      sessionId,
    );
    expect(
      isPastedImagePath(`${otherProjectImages}/12-clip.png`, cwd, ctx),
    ).toBe(false);
  });

  it('rejects unrelated tmp paths such as plans/', () => {
    const tmpProjectRoot = posix.join(
      getConfigHomeDir().replace(/\\/g, '/'),
      'tmp',
      projectId,
    );
    expect(
      isPastedImagePath(
        `${tmpProjectRoot}/${sessionId}/plans/draft.md`,
        cwd,
        ctx,
      ),
    ).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(
      isPastedImagePath(`${imagesDir}/CLIP.PNG`.toUpperCase(), cwd, ctx),
    ).toBe(true);
  });
});

describe('internalPaths · checkReadable/EditableInternalPath · pasted-image', () => {
  const sessionId = 'sid-abc';
  const ctx = contextFor(sessionId);
  const projectId = sanitizePath(cwd);
  const imagesDir = posix.join(
    getConfigHomeDir().replace(/\\/g, '/'),
    'tmp',
    projectId,
    'images',
    sessionId,
  );

  it('allows the pasted-image path through orchestrator with ctx', () => {
    const p = `${imagesDir}/12-clip.png`;
    expect(checkReadableInternalPath(p, cwd, ctx)).toBe(true);
    expect(checkEditableInternalPath(p, cwd, ctx)).toBe(true);
  });

  it('still allows pasted-image even without ctx (falls back to project-temp)', () => {
    // Without ctx, isPastedImagePath returns false but isProjectTempPath
    // covers the same subtree for project-level tmp data.
    const p = `${imagesDir}/12-clip.png`;
    expect(checkReadableInternalPath(p, cwd, contextFor())).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// isInboundUploadPath · ~/.{cliSlug}/uploads/{sid}/...
// ─────────────────────────────────────────────────────────────────────────

describe('internalPaths · isInboundUploadPath', () => {
  const sessionId = 'sid-abc';
  const ctx = contextFor(sessionId);
  // Reflect the fallback path: ${homedir}/.${BRAND_CLI_SLUG}/uploads/{sid}/
  // ENV_PRODUCT_HOME is unset in the test environment so the fallback applies.
  const expectedPrefix =
    posix.join(
      homedir().replace(/\\/g, '/'),
      `.${BRAND_CLI_SLUG}`,
      'uploads',
      sessionId,
    ) + '/';

  it('allows uploaded files in current session uploads dir', () => {
    expect(
      isInboundUploadPath(`${expectedPrefix}abc12345-report.pdf`, ctx),
    ).toBe(true);
  });

  it('allows arbitrary nested files (subdir tolerated)', () => {
    expect(isInboundUploadPath(`${expectedPrefix}sub/x.png`, ctx)).toBe(true);
  });

  it('rejects when ctx.sessionId is missing', () => {
    expect(isInboundUploadPath(`${expectedPrefix}abc-x.txt`)).toBe(false);
    expect(isInboundUploadPath(`${expectedPrefix}abc-x.txt`, {})).toBe(false);
  });

  it('rejects uploads from a different session (cross-session isolation)', () => {
    const otherPrefix =
      posix.join(
        homedir().replace(/\\/g, '/'),
        `.${BRAND_CLI_SLUG}`,
        'uploads',
        'sid-other',
      ) + '/';
    expect(isInboundUploadPath(`${otherPrefix}abc-x.txt`, ctx)).toBe(false);
  });

  it('rejects unrelated config-home paths', () => {
    expect(isInboundUploadPath('/some/random/path.txt', ctx)).toBe(false);
    // Even ~/.qwen/ — uploads land under ~/.{cliSlug}/, not ~/.qwen/.
    const wrongRoot = posix.join(
      homedir().replace(/\\/g, '/'),
      '.qwen',
      'uploads',
      sessionId,
      'x.txt',
    );
    // The matcher anchors on `.${BRAND_CLI_SLUG}`, not `.qwen`, so paths
    // under ~/.qwen/uploads should not match.
    expect(isInboundUploadPath(wrongRoot, ctx)).toBe(false);
  });

  it('respects ENV_PRODUCT_HOME override when set', () => {
    const fakeBase = '/tmp/fake-config-home';
    const original = process.env[ENV_PRODUCT_HOME];
    process.env[ENV_PRODUCT_HOME] = fakeBase;
    try {
      const p = posix.join(fakeBase, 'uploads', sessionId, 'x.txt');
      expect(
        isInboundUploadPath(p, {
          inboundUploadDir: posix.join(fakeBase, 'uploads', sessionId),
        }),
      ).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env[ENV_PRODUCT_HOME];
      } else {
        process.env[ENV_PRODUCT_HOME] = original;
      }
    }
  });

  it('matches case-insensitively', () => {
    expect(
      isInboundUploadPath(`${expectedPrefix}ABC-X.TXT`.toUpperCase(), ctx),
    ).toBe(true);
  });
});

describe('internalPaths · checkReadable/EditableInternalPath · inbound-upload', () => {
  const sessionId = 'sid-abc';
  const ctx = contextFor(sessionId);
  const expectedPrefix =
    posix.join(
      homedir().replace(/\\/g, '/'),
      `.${BRAND_CLI_SLUG}`,
      'uploads',
      sessionId,
    ) + '/';

  it('treats inbound-upload paths as readable internal paths', () => {
    expect(
      checkReadableInternalPath(`${expectedPrefix}abc-x.txt`, cwd, ctx),
    ).toBe(true);
  });

  it('does NOT treat inbound-upload as editable (read-only landing area)', () => {
    expect(
      checkEditableInternalPath(`${expectedPrefix}abc-x.txt`, cwd, ctx),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// isUserConfigPath · ~/.qwen/{skills,agents,policies,extensions}/...
// ─────────────────────────────────────────────────────────────────────────

describe('internalPaths · isUserConfigPath', () => {
  const home = getConfigHomeDir().replace(/\\/g, '/');

  it('allows files under ~/.qwen/skills/', () => {
    expect(
      isUserConfigPath(`${home}/skills/my-skill/SKILL.md`, contextFor()),
    ).toBe(true);
  });

  it('allows files under ~/.qwen/agents/', () => {
    expect(isUserConfigPath(`${home}/agents/my-agent.md`, contextFor())).toBe(
      true,
    );
  });

  it('allows files under ~/.qwen/policies/', () => {
    expect(
      isUserConfigPath(`${home}/policies/managed-settings.json`, contextFor()),
    ).toBe(true);
  });

  it('allows files under ~/.qwen/extensions/', () => {
    expect(
      isUserConfigPath(`${home}/extensions/cli-extension.json`, contextFor()),
    ).toBe(true);
  });

  it('rejects ~/.qwen/ root files (must be in a listed subdir)', () => {
    expect(isUserConfigPath(`${home}/settings.json`, contextFor())).toBe(false);
  });

  it('rejects unlisted subdirectories (e.g. tmp, projects)', () => {
    expect(isUserConfigPath(`${home}/tmp/x.txt`, contextFor())).toBe(false);
    expect(
      isUserConfigPath(`${home}/projects/abc/memory/x.md`, contextFor()),
    ).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(
      isUserConfigPath(`${home}/SKILLS/X.md`.toUpperCase(), contextFor()),
    ).toBe(true);
  });

  it('rejects paths outside ~/.qwen/', () => {
    expect(isUserConfigPath('/etc/skills/x.md', contextFor())).toBe(false);
  });
});

describe('internalPaths · checkReadableInternalPath · user-config', () => {
  const home = getConfigHomeDir().replace(/\\/g, '/');

  it('treats user-config paths as readable internal paths', () => {
    expect(
      checkReadableInternalPath(
        `${home}/skills/my-skill/SKILL.md`,
        cwd,
        contextFor(),
      ),
    ).toBe(true);
  });

  it('does NOT treat user-config paths as editable (read-only refs)', () => {
    expect(
      checkEditableInternalPath(
        `${home}/skills/my-skill/SKILL.md`,
        cwd,
        contextFor(),
      ),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// isSessionPlanFile · ~/.qwen/plans/*.md  (mode-independent)
// ─────────────────────────────────────────────────────────────────────────

describe('internalPaths · isSessionPlanFile', () => {
  const plansDir = posix.join(getConfigHomeDir().replace(/\\/g, '/'), 'plans');

  it('allows .md plan files under the global plans dir', () => {
    expect(isSessionPlanFile(`${plansDir}/draft.md`, contextFor())).toBe(true);
    expect(
      isSessionPlanFile(`${plansDir}/tender-juggling-karp.md`, contextFor()),
    ).toBe(true);
  });

  it('allows nested .md files under plans/', () => {
    expect(isSessionPlanFile(`${plansDir}/sub/2026-06.md`, contextFor())).toBe(
      true,
    );
  });

  it('rejects non-.md files (extension mismatch)', () => {
    expect(isSessionPlanFile(`${plansDir}/draft.txt`, contextFor())).toBe(
      false,
    );
    expect(isSessionPlanFile(`${plansDir}/note.json`, contextFor())).toBe(
      false,
    );
  });

  it('rejects files outside the plans dir', () => {
    expect(
      isSessionPlanFile(
        `${plansDir.replace('plans', 'tmp')}/x.md`,
        contextFor(),
      ),
    ).toBe(false);
    expect(isSessionPlanFile('/etc/draft.md', contextFor())).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(
      isSessionPlanFile(`${plansDir}/DRAFT.MD`.toUpperCase(), contextFor()),
    ).toBe(true);
  });

  it('does NOT depend on permission mode (mode flag decoupled)', () => {
    // The matcher takes only a path argument; no mode-dependent state.
    expect(isSessionPlanFile(`${plansDir}/draft.md`, contextFor())).toBe(true);
  });
});

describe('internalPaths · checkReadable/EditableInternalPath · session-plan', () => {
  const plansDir = posix.join(getConfigHomeDir().replace(/\\/g, '/'), 'plans');

  it('treats plan files as readable & editable in any mode', () => {
    const p = `${plansDir}/draft.md`;
    expect(checkReadableInternalPath(p, cwd, contextFor())).toBe(true);
    expect(checkEditableInternalPath(p, cwd, contextFor())).toBe(true);
  });
});

function getConfigHomeDir(): string {
  return qwenInternalPathDeps.resolve({ cwd }).userConfigDir!;
}
function contextFor(sessionId?: string): InternalPathContext {
  const context = qwenInternalPathDeps.resolve({ cwd, sessionId });
  return {
    ...context,
    taskOutputDir: sessionId
      ? computeIsolatedTaskOutputDir(sanitizePath(cwd), sessionId)
      : undefined,
  };
}
