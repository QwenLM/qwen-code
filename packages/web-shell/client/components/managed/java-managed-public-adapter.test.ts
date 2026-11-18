import { describe, expect, it } from 'vitest';
import type { components } from './generated/managed-agent-api';
import {
  publicActionPageToJava,
  publicAdmissionFromSession,
  publicApprovalChangeResultToJava,
  publicEventToJava,
  publicFileUploadStatusToJava,
  publicItemListToJava,
  publicOperationToJava,
  publicResyncToJava,
  publicSessionApprovalToJava,
  publicSessionPageToJava,
  publicSessionToJava,
  publicSideQueryToJava,
  publicTaskPageToJava,
  publicToolDetailsToJava,
  publicTranscriptToJava,
  publicTurnToJava,
  publicWorkspacePageToJava,
} from './java-managed-public-adapter';

type Schemas = components['schemas'];

// Realistic epochs: the Public wire carries SECONDS for Session/Turn/Event/
// Item and MILLIS for every other family. A fixture of 0 or 1 would pass
// under either unit and prove nothing.
const SECONDS = 1_790_777_114;
const MILLIS = 1_790_777_114_231;

const capabilities: Schemas['SessionCapabilities'] = {
  items: true,
  snapshots: true,
  artifacts: false,
  resync: true,
  actions: true,
  tasks: true,
  workspace_turns: true,
  session_close: true,
  session_archive: false,
  session_unarchive: false,
  session_delete: true,
  cwd_change: false,
  foreground_shell: false,
  model_change: true,
  approval_mode_change: true,
  input_attachments: false,
  rename: true,
  context_compression: true,
  child_agents: false,
  btw: true,
  recap: false,
  client_files: true,
};

const turn: Schemas['PublicTurn'] = {
  id: 'turn-1',
  object: 'agent.turn',
  session_id: 'session-1',
  input_item_id: 'item-input',
  status: 'completed',
  created_at: SECONDS,
  completed_at: SECONDS + 2,
  error_code: null,
};

const session: Schemas['PublicSession'] = {
  id: 'session-1',
  object: 'agent.session',
  agent_id: 'qwen-code',
  agent_revision: '1',
  status: 'active',
  created_at: SECONDS,
  updated_at: SECONDS + 5,
  metadata: { title: 'A title' },
  active_turn: null,
  latest_turn: turn,
  last_event_id: 42,
  replay_floor_sequence: 3,
  snapshot_through_sequence: 40,
  capabilities,
  workspace: {
    workspace_id: 'workspace-1',
    cwd_relative: '.',
    context_revision: 7,
    state: 'ready',
  },
  compaction_revision: 2,
  context_compression_operation_id: null,
  recovery: {
    state: 'idle',
    nextRecheckAt: MILLIS,
  } as Schemas['SessionRecovery'],
  worktree: {
    id: 'worktree-1',
    session_id: 'session-1',
    workspace_id: 'workspace-1',
    branch: 'qwen/session-1',
    base_commit: 'abc123',
    cwd_relative: '.',
    operation_id: 'op-1',
    state: 'ready',
    revision: 1,
    error_code: null,
  },
  title: 'A title',
  environment: { state: 'ready', environmentId: 'env-1' },
  approval_mode: 'auto-edit',
  approval_revision: 4,
  initial_approval_mode: 'default',
  plan_mode: true,
  plan_mode_supported: true,
  model_context: {
    model_id: 'model-a',
    input_tokens: 1234,
    context_window_size: 200000,
    observed_at: MILLIS,
  },
  model_selection: { model_id: 'model-a', revision: 2 },
  lifecycle_operation: {
    operation_id: 'op-close',
    type: 'close',
    status: 'running',
    failure_code: null,
  },
};

describe('java-managed-public-adapter', () => {
  it('converts Session seconds to millis and maps every enriched field', () => {
    const adapted = publicSessionToJava(session);
    expect(adapted.sessionId).toBe('session-1');
    expect(adapted.createdAt).toBe(SECONDS * 1000);
    expect(adapted.updatedAt).toBe((SECONDS + 5) * 1000);
    expect(adapted.lastSequence).toBe(42);
    expect(adapted.title).toBe('A title');
    expect(adapted.approvalMode).toBe('auto-edit');
    expect(adapted.approvalRevision).toBe(4);
    expect(adapted.initialApprovalMode).toBe('default');
    expect(adapted.planMode).toBe(true);
    expect(adapted.planModeSupported).toBe(true);
    expect(adapted.compactionRevision).toBe(2);
    expect(adapted.contextCompressionOperationId).toBeNull();
    expect(adapted.environment).toEqual({
      state: 'ready',
      environmentId: 'env-1',
    });
    expect(adapted.workspace).toEqual({
      workspaceId: 'workspace-1',
      cwdRelative: '.',
      contextRevision: 7,
      state: 'ready',
    });
    expect(adapted.worktree).toEqual({
      id: 'worktree-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      branch: 'qwen/session-1',
      baseCommit: 'abc123',
      cwdRelative: '.',
      operationId: 'op-1',
      state: 'ready',
      revision: 1,
      errorCode: null,
    });
    expect(adapted.modelContext).toEqual({
      modelId: 'model-a',
      inputTokens: 1234,
      contextWindowSize: 200000,
      // observed_at is millis on BOTH wires: never scaled.
      observedAt: MILLIS,
    });
    expect(adapted.modelSelection).toEqual({ modelId: 'model-a', revision: 2 });
    expect(adapted.lifecycleOperation).toEqual({
      operationId: 'op-close',
      type: 'close',
      status: 'running',
      failureCode: null,
    });
    expect(adapted.recovery).toBe(session.recovery);
  });

  it('takes activeTurn from latest_turn, not the ACTIVE-only active_turn', () => {
    const adapted = publicSessionToJava({
      ...session,
      active_turn: { ...turn, id: 'turn-active', status: 'running' },
      latest_turn: turn,
    });
    expect(adapted.activeTurn?.turnId).toBe('turn-1');
    expect(adapted.activeTurn?.status).toBe('completed');
    expect(adapted.activeTurn?.submittedAt).toBe(SECONDS * 1000);
    expect(adapted.activeTurn?.completedAt).toBe((SECONDS + 2) * 1000);

    const noTurns = publicSessionToJava({
      ...session,
      active_turn: null,
      latest_turn: undefined,
    });
    expect(noTurns.activeTurn).toBeNull();
  });

  it('maps capabilities to camelCase and derives diagnostics from tasks', () => {
    const adapted = publicSessionToJava(session).capabilities;
    expect(adapted).toEqual({
      tasks: true,
      artifacts: false,
      actions: true,
      workspaceTurns: true,
      sessionClose: true,
      sessionArchive: false,
      sessionUnarchive: false,
      sessionDelete: true,
      cwdChange: false,
      foregroundShell: false,
      modelChange: true,
      approvalModeChange: true,
      inputAttachments: false,
      rename: true,
      contextCompression: true,
      childAgents: false,
      diagnostics: true,
      btw: true,
      recap: false,
      clientFiles: true,
    });
    const noTasks = publicSessionToJava({
      ...session,
      capabilities: { ...capabilities, tasks: false },
    });
    expect(noTasks.capabilities.diagnostics).toBe(false);
  });

  it('preserves null and absent optional projections', () => {
    const adapted = publicSessionToJava({
      ...session,
      worktree: null,
      latest_turn: undefined,
      model_context: undefined,
      model_selection: undefined,
      lifecycle_operation: undefined,
      title: null,
      environment: null,
    });
    expect(adapted.worktree).toBeNull();
    expect(adapted.activeTurn).toBeNull();
    expect(adapted.modelContext).toBeUndefined();
    expect(adapted.modelSelection).toBeUndefined();
    expect(adapted.lifecycleOperation).toBeUndefined();
    expect(adapted.title).toBeNull();
    expect(adapted.environment).toBeNull();
  });

  it('converts Turn seconds and keeps a null completion null', () => {
    const adapted = publicTurnToJava({ ...turn, completed_at: null });
    expect(adapted.turnId).toBe('turn-1');
    expect(adapted.submittedAt).toBe(SECONDS * 1000);
    expect(adapted.completedAt).toBeNull();
    expect(publicTurnToJava(turn).completedAt).toBe((SECONDS + 2) * 1000);
  });

  it('converts Event seconds and passes the data payload through untouched', () => {
    const data = { toolName: 'shell', nested: { keepCamel: true } };
    const event: Schemas['PublicEvent'] = {
      schema_version: 1,
      projection_version: 2,
      sequence: 9,
      event_id: 'event-1',
      session_id: 'session-1',
      turn_id: 'turn-1',
      item_id: 'item-1',
      content_part_id: null,
      type: 'item.completed',
      created_at: SECONDS,
      data,
      terminal: false,
    };
    const adapted = publicEventToJava(event);
    expect(adapted.eventId).toBe('event-1');
    expect(adapted.createdAt).toBe(SECONDS * 1000);
    expect(adapted.schemaVersion).toBe(1);
    expect(adapted.projectionVersion).toBe(2);
    expect(adapted.contentPartId).toBeNull();
    // The data payload is a shared record body: its keys must NOT be
    // re-keyed by the adapter.
    expect(adapted.data).toBe(data);
  });

  it('maps the resync frame to the camelCase contract', () => {
    expect(
      publicResyncToJava({
        type: 'agent.session.resync_required',
        session_id: 'session-1',
        replay_floor_sequence: 5,
        snapshot_through_sequence: 40,
        action: 'reload_snapshot',
      }),
    ).toEqual({
      type: 'agent.session.resync_required',
      sessionId: 'session-1',
      replayFloorSequence: 5,
      snapshotThroughSequence: 40,
      action: 'reload_snapshot',
    });
  });

  it('converts Item seconds and defaults the projections WebShell required', () => {
    const item: Schemas['PublicItem'] = {
      id: 'item-1',
      object: 'agent.item',
      session_id: 'session-1',
      turn_id: 'turn-1',
      type: 'message',
      role: 'assistant',
      revision: 3,
      status: 'completed',
      first_sequence: 1,
      last_sequence: 8,
      content: [
        {
          part_id: 'part-1',
          type: 'output_text',
          text: 'hello',
          first_sequence: 2,
          last_sequence: 8,
        },
      ],
      attributes: { toolName: 'shell' },
      created_at: SECONDS,
      updated_at: SECONDS + 1,
    };
    const adapted = publicItemListToJava({
      object: 'list',
      data: [item],
      has_more: true,
      next_cursor: 'cursor-1',
      snapshot_through_sequence: 40,
    });
    expect(adapted.snapshotThroughSequence).toBe(40);
    expect(adapted.hasMore).toBe(true);
    expect(adapted.nextCursor).toBe('cursor-1');
    expect(adapted.items[0]).toEqual({
      itemId: 'item-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          partId: 'part-1',
          type: 'output_text',
          text: 'hello',
          firstSequence: 2,
          lastSequence: 8,
        },
      ],
      attributes: { toolName: 'shell' },
      firstSequence: 1,
      lastSequence: 8,
      createdAt: SECONDS * 1000,
      updatedAt: (SECONDS + 1) * 1000,
    });

    const sparse = publicItemListToJava({
      object: 'list',
      data: [
        {
          ...item,
          turn_id: null,
          attributes: undefined,
          created_at: undefined,
          updated_at: undefined,
        },
      ],
      has_more: false,
      next_cursor: null,
      snapshot_through_sequence: 0,
    });
    expect(sparse.items[0].turnId).toBe('');
    expect(sparse.items[0].attributes).toEqual({});
    expect(sparse.items[0].createdAt).toBe(0);
    expect(sparse.items[0].updatedAt).toBe(0);
  });

  it('maps the transcript envelope with per-element second conversion', () => {
    const adapted = publicTranscriptToJava({
      items: [],
      events: [
        {
          schema_version: 1,
          projection_version: 1,
          sequence: 1,
          event_id: 'event-1',
          session_id: 'session-1',
          type: 'turn.accepted',
          created_at: SECONDS,
          data: {},
          terminal: false,
        },
      ],
      covered_sequence: 12,
      older_cursor: 'older',
      has_more: false,
      last_sequence: 42,
    });
    expect(adapted.coveredSequence).toBe(12);
    expect(adapted.olderCursor).toBe('older');
    expect(adapted.lastSequence).toBe(42);
    expect(adapted.events[0].createdAt).toBe(SECONDS * 1000);
  });

  it('keeps task millis untouched and maps the page envelope', () => {
    const task: Schemas['PublicTask'] = {
      id: 'task-1',
      object: 'agent.task',
      session_id: 'session-1',
      child_session_id: 'session-child',
      kind: 'child_agent',
      state: 'running',
      runtime_state: 'running_attached',
      created_at: MILLIS,
      started_at: MILLIS + 1,
      settled_at: undefined,
      output_cursor: 'cursor',
      artifact_refs: [],
      action_capabilities: ['cancel'],
      stop_requested: false,
    } as Schemas['PublicTask'];
    const adapted = publicTaskPageToJava({
      object: 'list',
      data: [task],
      has_more: false,
      next_cursor: null,
      active_child_count: 2,
    });
    expect(adapted.activeChildCount).toBe(2);
    expect(adapted.data[0].taskId).toBe('task-1');
    expect(adapted.data[0].childSessionId).toBe('session-child');
    expect(adapted.data[0].runtimeState).toBe('running_attached');
    expect(adapted.data[0].actionCapabilities).toEqual(['cancel']);
    // Task timestamps are millis on both wires: identical, never scaled.
    expect(adapted.data[0].createdAt).toBe(MILLIS);
    expect(adapted.data[0].startedAt).toBe(MILLIS + 1);
  });

  it('keeps side-query millis untouched and maps the prefix', () => {
    const adapted = publicSideQueryToJava({
      query_id: 'query-1',
      session_id: 'session-1',
      kind: 'btw',
      trigger: 'manual',
      question: 'why?',
      status: 'completed',
      outcome: 'answered',
      source: {
        journal_revision: 5,
        committed_sequence: 30,
        last_commit_digest: 'digest',
        completed_turn_sequence: 12,
        content_version: 'v1',
        completed_user_turn_count: 3,
        main_input_boundary: 14,
      },
      result_revision: 2,
      text: 'because',
      usage: null,
      error_code: null,
      created_at: MILLIS,
      updated_at: MILLIS + 2,
      deadline_at: MILLIS + 60_000,
    });
    expect(adapted.queryId).toBe('query-1');
    expect(adapted.resultRevision).toBe(2);
    expect(adapted.errorCode).toBeNull();
    expect(adapted.createdAt).toBe(MILLIS);
    expect(adapted.updatedAt).toBe(MILLIS + 2);
    expect(adapted.deadlineAt).toBe(MILLIS + 60_000);
    expect(adapted.source).toEqual({
      journalRevision: 5,
      committedSequence: 30,
      lastCommitDigest: 'digest',
      completedTurnSequence: 12,
      contentVersion: 'v1',
      completedUserTurnCount: 3,
      mainInputBoundary: 14,
    });
  });

  it('maps permission and question actions with nested shapes', () => {
    const adapted = publicActionPageToJava({
      data: [
        {
          id: 'action-1',
          session_id: 'session-1',
          kind: 'permission',
          source: { kind: 'tool_call', id: 'call-1' },
          state: 'requested',
          input_revision: 1,
          policy_revision: 'policy-1',
          created_at: MILLIS,
          expires_at: MILLIS + 30_000,
          options: [{ id: 'allow', label: 'Allow' }],
          turn_id: 'turn-1',
          function_call_id: 'call-1',
          tool_name: 'shell',
          input_preview: { text: 'ls', truncated: false, byte_length: 2 },
        },
        {
          id: 'action-2',
          session_id: 'session-1',
          kind: 'question',
          source: { kind: 'tool_call', id: 'call-2' },
          state: 'requested',
          input_revision: 1,
          policy_revision: 'policy-1',
          created_at: MILLIS,
          expires_at: MILLIS + 30_000,
          turn_id: 'turn-1',
          function_call_id: 'call-2',
          tool_name: 'ask',
          questions: [
            {
              id: 'q1',
              prompt: 'Which?',
              required: true,
              multiple: false,
              allow_text: true,
              options: [{ id: 'a', label: 'A' }],
            },
          ],
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    expect(adapted.data[0]).toMatchObject({
      actionId: 'action-1',
      kind: 'permission',
      functionCallId: 'call-1',
      toolName: 'shell',
      inputRevision: 1,
      policyRevision: 'policy-1',
      createdAt: MILLIS,
      expiresAt: MILLIS + 30_000,
      inputPreview: { text: 'ls', truncated: false, byteLength: 2 },
    });
    expect(adapted.data[1]).toMatchObject({
      actionId: 'action-2',
      kind: 'question',
      questions: [
        {
          id: 'q1',
          prompt: 'Which?',
          required: true,
          multiple: false,
          allowText: true,
          options: [{ id: 'a', label: 'A' }],
        },
      ],
    });
  });

  it('structures the inline Public permission rules and defaults a null mode', () => {
    const approval = publicSessionApprovalToJava({
      approval_mode: null,
      approval_revision: 0,
      available_approval_modes: ['default', 'auto-edit'],
      supported: true,
      plan_mode: false,
      plan_mode_supported: true,
      live_supported: true,
      permission_rules_supported: true,
      permission_rules: { allow: ['shell'], ask: [], deny: ['rm'] },
    });
    expect(approval.approvalMode).toBe('default');
    expect(approval.availableApprovalModes).toEqual(['default', 'auto-edit']);
    expect(approval.liveSupported).toBe(true);
    expect(approval.permissionRules).toEqual({
      allow: ['shell'],
      ask: [],
      deny: ['rm'],
    });

    const changed = publicApprovalChangeResultToJava({
      session_id: 'session-1',
      approval_mode: 'yolo',
      approval_revision: 3,
      replayed: true,
      plan_mode: false,
    });
    expect(changed.approvalMode).toBe('yolo');
    expect(changed.replayed).toBe(true);
    expect(changed.permissionRules).toBeUndefined();
  });

  it('synthesizes the create admission from latest_turn and the replay header flag', () => {
    expect(publicAdmissionFromSession(session, false)).toEqual({
      sessionId: 'session-1',
      turnId: 'turn-1',
      status: 'accepted',
      replayed: false,
    });
    expect(
      publicAdmissionFromSession({ ...session, latest_turn: undefined }, true),
    ).toEqual({
      sessionId: 'session-1',
      turnId: null,
      status: 'accepted',
      replayed: true,
    });
  });

  it('dispatches the operation union and renames id to operationId', () => {
    const command = publicOperationToJava({
      id: 'op-1',
      session_id: 'session-1',
      type: 'close',
      status: 'completed',
      admission_stage: 'harness_confirmed',
      delivery_state: 'confirmed',
      replayed: false,
      action_resolution: {
        action_id: 'action-1',
        outcome: 'decided',
        receipt_id: 'receipt-1',
        decision_receipt_id: 'decision-1',
      },
    } as Schemas['PublicOperation']);
    expect(command.operationId).toBe('op-1');
    expect(command.type).toBe('close');
    expect(command).toMatchObject({
      admissionStage: 'harness_confirmed',
      deliveryState: 'confirmed',
      actionResolution: {
        actionId: 'action-1',
        outcome: 'decided',
        receiptId: 'receipt-1',
        decisionReceiptId: 'decision-1',
      },
    });

    const compression = publicOperationToJava({
      id: 'op-2',
      session_id: 'session-1',
      type: 'context_compression',
      status: 'completed',
      expected_compaction_revision: 1,
      compaction_revision: 2,
      outcome: 'compressed',
      failure_code: null,
      replayed: false,
    });
    expect(compression.operationId).toBe('op-2');
    expect(compression).toMatchObject({
      expectedCompactionRevision: 1,
      compactionRevision: 2,
      outcome: 'compressed',
    });

    const cwd = publicOperationToJava({
      id: 'op-3',
      session_id: 'session-1',
      type: 'cwd_change',
      status: 'completed',
      expected_context_revision: 1,
      target_cwd_relative: 'sub',
      result_context_revision: 2,
      failure_code: null,
      replayed: false,
    } as Schemas['PublicOperation']);
    expect(cwd.operationId).toBe('op-3');
    expect(cwd).toMatchObject({
      expectedContextRevision: 1,
      targetCwdRelative: 'sub',
      resultContextRevision: 2,
    });
  });

  it('maps shell tool details and defaults the upload status nulls', () => {
    const details = publicToolDetailsToJava({
      input: { command: 'ls' },
      output: 'file.txt',
      truncated: false,
      shell_result: {
        type: 'shell_result',
        version: 1,
        text: 'file.txt',
        output: 'file.txt',
        directory: '.',
        exit_code: 0,
        signal: null,
        pid: 123,
        error: null,
        outcome: 'completed',
        notices: [],
        truncated: false,
        output_files: ['file.txt'],
      },
    });
    expect(details.shellResult).toMatchObject({
      exitCode: 0,
      pid: 123,
      outcome: 'completed',
      outputFiles: ['file.txt'],
    });

    const status = publicFileUploadStatusToJava({
      scope_revision: 'scope',
      upload_id: 'upload-1',
      state: 'completed',
      path: 'file.txt',
      size_bytes: 4,
      sha256: null,
      code: null,
    });
    expect(status.uploadId).toBe('upload-1');
    expect(status.sizeBytes).toBe(4);
    expect(status.sha256).toBe('');
    expect(status.code).toBeUndefined();
  });

  it('maps the workspace page capabilities and default narrowing', () => {
    const adapted = publicWorkspacePageToJava({
      object: 'list',
      data: [
        {
          id: 'workspace-1',
          object: 'agent.workspace',
          display_name: 'Workspace',
          can_create_session: true,
          state: 'active',
          default_cwd_relative: '.',
          can_select_directory: true,
        },
      ],
      has_more: false,
      next_cursor: null,
      capabilities: {
        workspace_context: false,
        workspace_binding: true,
        workspace_creation: true,
        approval_mode_selection: true,
        directory_selection: false,
        local_directory_import: true,
      },
      default_workspace: {
        id: 'workspace-1',
        object: 'agent.workspace',
        display_name: 'Workspace',
        can_create_session: true,
        state: 'active',
      },
    });
    expect(adapted.capabilities).toEqual({
      workspaceContext: false,
      workspaceBinding: true,
      workspaceCreation: true,
      approvalModeSelection: true,
      workspaceDirectorySelection: false,
      localDirectoryImport: true,
    });
    expect(adapted.data[0].workspaceId).toBe('workspace-1');
    expect(adapted.data[0].defaultCwdRelative).toBe('.');
    expect(adapted.data[0].canSelectDirectory).toBe(true);
    expect(adapted.defaultWorkspace?.workspaceId).toBe('workspace-1');
    expect(adapted.defaultWorkspace?.state).toBe('active');
    expect(adapted.defaultWorkspace?.canCreateSession).toBe(true);
  });

  it('maps the session page envelope', () => {
    const adapted = publicSessionPageToJava({
      object: 'list',
      data: [session],
      has_more: true,
      next_cursor: 'cursor-2',
    });
    expect(adapted.hasMore).toBe(true);
    expect(adapted.nextCursor).toBe('cursor-2');
    expect(adapted.data[0].sessionId).toBe('session-1');
    expect(adapted.data[0].createdAt).toBe(SECONDS * 1000);
  });
});
