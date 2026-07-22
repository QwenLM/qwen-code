/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon-local workspace skills enumeration.
 *
 * `/workspace/skills` is normally answered by the ACP child (which owns the
 * live `SkillManager`). But the child is not always available before the
 * first prompt: session creation is deferred until then, and the startup
 * preheat can time out on a slow cold start — most visibly under
 * `npm run dev`, where the child is transpiled on demand and its
 * `initialize` handshake routinely exceeds the 10s preheat budget, so no
 * channel ever comes up. In that window the child cannot list skills, which
 * drops skill-backed slash commands (e.g. `/review`) from the Web Shell's
 * pre-first-prompt autocomplete even though the skills exist on disk.
 *
 * This provider enumerates skills directly from the filesystem via
 * `SkillManager`, with no child and no MCP initialization, so the daemon can
 * answer `/workspace/skills` instantly whenever the child is unavailable.
 * `SkillManager.listSkills()` only reads a handful of `Config` getters
 * (safe/bare mode, project root, active extensions), so a lightweight config
 * shim is sufficient — no full `Config` construction (and no `initialize()`
 * side effects) required. The live child, when present, stays authoritative:
 * the facade only falls back here after a real child answer and the cached
 * last answer are both unavailable, and this daemon-local view intentionally
 * omits extension-provided skills (there is no active-extension context
 * outside the child) — those still surface once a session exists.
 */

import { SkillManager, isSafeModeEnv } from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';
import type { ServeWorkspaceSkillsStatus } from '@qwen-code/acp-bridge/status';
import { STATUS_SCHEMA_VERSION } from '@qwen-code/acp-bridge/status';
import { loadSettings } from '../config/settings.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { mapSkillConfigToStatus } from './workspace-skills-mapping.js';
import { resolveSkillSettings } from '../config/skill-settings.js';

export interface WorkspaceSkillsStatusProvider {
  (workspaceCwd: string): Promise<ServeWorkspaceSkillsStatus>;
  invalidate?(workspaceCwd: string): void;
}

/**
 * The `Config` surface `SkillManager.listSkills()` actually reads. Declaring it
 * as a `Pick` (rather than casting an inline object literal) type-checks the
 * shimmed getters against `Config`'s real signatures, so a signature drift is
 * caught at compile time. Should `SkillManager` grow a dependency on some other
 * `Config` method, that call would be `undefined` at runtime — which
 * `buildWorkspaceSkillsStatus`'s try/catch turns into an empty, non-initialized
 * status (the facade then leaves skills to the live child) rather than a crash.
 */
type SkillManagerConfigShim = Pick<
  Config,
  'isSafeMode' | 'getBareMode' | 'getProjectRoot' | 'getActiveExtensions'
>;

export function createWorkspaceSkillsStatusProvider(): WorkspaceSkillsStatusProvider {
  // Reuse one SkillManager per workspace so repeat queries hit its in-memory
  // skills cache instead of re-scanning (and re-parsing frontmatter / compiling
  // globs for) every level on each call. This is a best-effort pre-child
  // fallback, so the slight staleness — a skill added on disk mid-run is not
  // picked up until the daemon restarts — is acceptable: the live child
  // re-lists authoritatively once a session exists.
  const managers = new Map<string, SkillManager>();
  const provider = ((workspaceCwd: string) =>
    buildWorkspaceSkillsStatus(
      workspaceCwd,
      managers,
    )) as WorkspaceSkillsStatusProvider;
  provider.invalidate = (workspaceCwd) => managers.delete(workspaceCwd);
  return provider;
}

async function buildWorkspaceSkillsStatus(
  workspaceCwd: string,
  managers: Map<string, SkillManager>,
): Promise<ServeWorkspaceSkillsStatus> {
  try {
    let skillManager = managers.get(workspaceCwd);
    if (!skillManager) {
      const shim: SkillManagerConfigShim = {
        // Honor the safe-mode env the same way `Config` does when no explicit
        // flag is passed, so an operator running in safe mode gets the same
        // bundled-only listing the child would produce.
        isSafeMode: () => isSafeModeEnv(),
        // Bare mode is the interactive `--bare` CLI flag; the daemon never runs
        // bare, so it is always off here.
        getBareMode: () => false,
        getProjectRoot: () => workspaceCwd,
        // Extension skills need active-extension context that only the child
        // has; omit them here and let the session snapshot surface them.
        getActiveExtensions: () => [],
      };
      skillManager = new SkillManager(shim as Config);
      managers.set(workspaceCwd, skillManager);
    }
    const disablements = resolveSkillSettings(
      loadSettings(workspaceCwd, {
        consumeCorruptionEnvVars: false,
        skipLoadEnvironment: true,
      }),
    ).disablements;
    const skills = await skillManager.listSkills();
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd,
      initialized: true,
      skills: skills.map((skill) =>
        mapSkillConfigToStatus(skill, disablements),
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderrLine(
      `qwen serve: daemon-local skills enumeration failed for ${workspaceCwd}: ${message}`,
    );
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd,
      initialized: false,
      skills: [],
      errors: [
        {
          kind: 'skills',
          status: 'error',
          error: message,
        },
      ],
    };
  }
}
