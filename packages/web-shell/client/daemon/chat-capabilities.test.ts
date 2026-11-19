import { describe, expect, it } from 'vitest';
import { SERVE_CAPABILITY_REGISTRY } from '@qwen-code/sdk/daemon';
import { DAEMON_CHAT_CAPABILITY_MAP } from './chat-capabilities.js';

// Every non-empty decision, pinned literally: any assignment moving to []
// or to another region, and any empty tag gaining a region, flips this red.
const NON_EMPTY_DECISIONS = {
  session_side_task: ['tasks'],
  session_artifacts: ['artifacts'],
  session_artifacts_persistence: ['artifacts'],
  session_artifact_library: ['artifacts'],
  workspace_artifact_library: ['artifacts'],
  workspace_artifact_library_stream: ['artifacts'],
  session_set_model: ['modelSelection'],
  session_context_usage: ['contextUsage'],
  session_tasks: ['tasks'],
  session_agents: ['tasks'],
  session_agent_trace: ['diagnostics'],
  session_stats: ['usageStats'],
  session_resources: ['diagnostics'],
  session_close: ['sessionOps'],
  session_archive: ['sessionOps'],
  session_metadata: ['sessionOps'],
  session_organization: ['sessionOps'],
  session_export: ['sessionOps'],
  session_approval_mode_control: ['approvalSelection'],
  workspace_session_export: ['sessionOps'],
  workspace_archived_session_export: ['sessionOps'],
  workspace_session_metadata: ['sessionOps'],
  web_terminal: ['terminal'],
};

describe('daemon chat capability map', () => {
  it('covers exactly the canonical registry tags', () => {
    expect(Object.keys(DAEMON_CHAT_CAPABILITY_MAP).sort()).toEqual(
      Object.keys(SERVE_CAPABILITY_REGISTRY).sort(),
    );
  });

  it('pins every non-empty region assignment', () => {
    const nonEmpty = Object.fromEntries(
      Object.entries(DAEMON_CHAT_CAPABILITY_MAP).filter(
        ([, regions]) => regions.length > 0,
      ),
    );
    expect(nonEmpty).toEqual(NON_EMPTY_DECISIONS);
  });

  it('keeps transport and daemon-only tags out of the shared regions', () => {
    expect(DAEMON_CHAT_CAPABILITY_MAP.health).toEqual([]);
    expect(DAEMON_CHAT_CAPABILITY_MAP.require_auth).toEqual([]);
    expect(DAEMON_CHAT_CAPABILITY_MAP.realtime_voice).toEqual([]);
    expect(DAEMON_CHAT_CAPABILITY_MAP.workspace_local_terminal).toEqual([]);
    expect(DAEMON_CHAT_CAPABILITY_MAP.session_worktree_branch_v1).toEqual([]);
    expect(DAEMON_CHAT_CAPABILITY_MAP.session_worktree_handoff_v1).toEqual([]);
  });
});
