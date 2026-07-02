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

import { SkillManager } from '@qwen-code/qwen-code-core';
import type { Config, SkillConfig } from '@qwen-code/qwen-code-core';
import type {
  ServeWorkspaceSkillStatus,
  ServeWorkspaceSkillsStatus,
} from '@qwen-code/acp-bridge/status';
import { STATUS_SCHEMA_VERSION } from '@qwen-code/acp-bridge/status';

export type WorkspaceSkillsStatusProvider = (
  workspaceCwd: string,
) => Promise<ServeWorkspaceSkillsStatus>;

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
  return (workspaceCwd) => buildWorkspaceSkillsStatus(workspaceCwd);
}

async function buildWorkspaceSkillsStatus(
  workspaceCwd: string,
): Promise<ServeWorkspaceSkillsStatus> {
  try {
    const shim: SkillManagerConfigShim = {
      // The daemon binds to an operator-chosen workspace and only lists skills
      // for autocomplete (the child gates execution), so enumerate all levels
      // rather than restricting to bundled-only safe mode.
      isSafeMode: () => false,
      getBareMode: () => false,
      getProjectRoot: () => workspaceCwd,
      // Extension skills need active-extension context that only the child
      // has; omit them here and let the session snapshot surface them.
      getActiveExtensions: () => [],
    };
    const skillManager = new SkillManager(shim as Config);
    const skills = await skillManager.listSkills();
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd,
      initialized: true,
      skills: skills.map(mapSkill),
    };
  } catch (error) {
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd,
      initialized: false,
      skills: [],
      errors: [
        {
          kind: 'skills',
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

function mapSkill(skill: SkillConfig): ServeWorkspaceSkillStatus {
  const modelInvocable = skill.disableModelInvocation !== true;
  return {
    kind: 'skill',
    status: modelInvocable ? 'ok' : 'disabled',
    name: skill.name,
    description: skill.description,
    level: skill.level,
    modelInvocable,
    ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
    ...(skill.model ? { model: skill.model } : {}),
    ...(skill.extensionName ? { extensionName: skill.extensionName } : {}),
  };
}
