/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TodoWriteParams } from './todoWrite.js';
import { TodoWriteTool, listTodoSessions } from './todoWrite.js';
import type { ToolResult } from './tools.js';
import { DefaultHookOutput, HookPhase, type TodoItem } from '../hooks/types.js';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import type { AggregatedHookResult } from '../hooks/hookAggregator.js';
import { Storage } from '../config/storage.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { promptIdContext } from '../utils/promptIdContext.js';

// Mock fs modules
vi.mock('fs/promises');
vi.mock('fs');

vi.mock('../utils/atomicFileWrite.js', () => ({
  atomicWriteFile: vi.fn(),
}));

const mockFs = vi.mocked(fs);
const mockFsSync = vi.mocked(fsSync);
const mockAtomicWrite = vi.mocked(atomicWriteFile);

const MODIFIED = 'Todos have been modified successfully';

/** A todo item; `blockedBy` is present only when given. */
function todo(
  id: string,
  content: string,
  status: TodoItem['status'],
  blockedBy?: string[],
): TodoItem {
  return { id, content, status, ...(blockedBy ? { blockedBy } : {}) };
}

/** No todo file yet: `readFile` rejects with a proper ENOENT Error. */
function noTodoFile(): void {
  const enoentError = new Error('ENOENT') as Error & { code: string };
  enoentError.code = 'ENOENT';
  mockFs.readFile.mockRejectedValue(enoentError);
}

/** The persisted todo file holds `data`. */
function storedTodos(data: { planId?: string; todos: TodoItem[] }): void {
  mockFs.readFile.mockResolvedValue(JSON.stringify(data));
}

function writesSucceed(): void {
  mockFs.mkdir.mockResolvedValue(undefined);
  mockAtomicWrite.mockResolvedValue(undefined);
}

/** The parsed body of the first atomic write. */
function written() {
  return JSON.parse(mockAtomicWrite.mock.calls[0][1] as string);
}

/** One hook output (repeated as the final output) with `decision`/`reason`. */
function hookResult(
  decision: 'allow' | 'block',
  reason?: string,
  totalDuration = 10,
): AggregatedHookResult {
  const output = () =>
    new DefaultHookOutput(reason ? { decision, reason } : { decision });
  return {
    success: true,
    allOutputs: [output()],
    errors: [],
    totalDuration,
    finalOutput: output(),
  };
}

describe('TodoWriteTool', () => {
  let tool: TodoWriteTool;
  let mockAbortSignal: AbortSignal;
  let mockConfig: Config;

  /** Rebuilds the tool over a Config holding `methods` plus the session id. */
  function setConfig(methods: Record<string, unknown>): void {
    mockConfig = {
      getSessionId: () => 'test-session-123',
      ...methods,
    } as unknown as Config;
    tool = new TodoWriteTool(mockConfig);
  }

  function withHooks(
    fireTodoCreatedEvent = vi.fn(),
    fireTodoCompletedEvent = vi.fn(),
  ) {
    const hookSystem = { fireTodoCreatedEvent, fireTodoCompletedEvent };
    setConfig({ getHookSystem: () => hookSystem });
    return hookSystem;
  }

  function setWorkflowConfig(methods: Record<string, unknown> = {}): void {
    setConfig({
      getHookSystem: () => undefined,
      ...methods,
      isSessionWorkflowTodoContextActive: vi.fn().mockReturnValue(true),
      setActiveTodoReminder: vi.fn(),
    });
  }

  const run = (params: TodoWriteParams) =>
    tool.build(params).execute(mockAbortSignal);
  const runInPrompt = (params: TodoWriteParams) =>
    promptIdContext.run('todo-prompt', () => run(params));
  const lastReminder = () =>
    vi.mocked(mockConfig.setActiveTodoReminder).mock.lastCall?.[1];

  beforeEach(() => {
    setConfig({
      getHookSystem: () => undefined,
      isSessionWorkflowTodoContextActive: () => false,
      setActiveTodoReminder: vi.fn(),
    });
    mockAbortSignal = new AbortController().signal;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validateToolParams', () => {
    it.each([
      [
        'should validate correct parameters',
        [todo('1', 'Task 1', 'pending'), todo('2', 'Task 2', 'in_progress')],
      ],
      ['should accept empty todos array', []],
      ['should accept single todo', [todo('1', 'Task 1', 'pending')]],
      [
        'should accept a valid dependency graph',
        [
          todo('design', 'Design', 'completed'),
          todo('build', 'Build', 'pending', ['design']),
        ],
      ],
    ])('%s', (_title, todos) => {
      expect(tool.validateToolParams({ todos })).toBeNull();
    });

    it.each([
      [
        'should reject todos with empty content',
        [todo('1', '', 'pending'), todo('2', 'Task 2', 'pending')],
        'Each todo must have a non-empty "content" string',
      ],
      [
        'should reject todos with empty id',
        [todo('', 'Task 1', 'pending'), todo('2', 'Task 2', 'pending')],
        'non-empty "id" string',
      ],
      [
        'should reject todos with invalid status',
        [
          todo('1', 'Task 1', 'invalid' as TodoItem['status']),
          todo('2', 'Task 2', 'pending'),
        ],
        'Each todo must have a valid "status" (pending, in_progress, completed)',
      ],
      [
        'should reject todos with duplicate IDs',
        [todo('1', 'Task 1', 'pending'), todo('1', 'Task 2', 'pending')],
        'unique',
      ],
    ])('%s', (_title, todos, error) => {
      expect(tool.validateToolParams({ todos })).toContain(error);
    });

    it('should reject oversized todo and dependency ids', () => {
      const long = 'x'.repeat(501);
      expect(
        tool.validateToolParams({ todos: [todo(long, 'Task', 'pending')] }),
      ).toContain('at most 500 characters');
      expect(
        tool.validateToolParams({
          todos: [todo('task', 'Task', 'pending', [long])],
        }),
      ).toContain('at most 500 characters');
    });

    it('should validate deep dependency chains without recursive traversal', () => {
      const todos = Array.from({ length: 3_000 }, (_, index) =>
        todo(
          `todo-${index}`,
          `Todo ${index}`,
          'pending',
          index === 0 ? undefined : [`todo-${index - 1}`],
        ),
      );

      expect(tool.validateToolParams({ todos })).toBeNull();
    });

    it.each([
      {
        name: 'duplicate dependency',
        todos: [
          todo('a', 'A', 'pending'),
          todo('b', 'B', 'pending', ['a', 'a']),
        ],
        error: 'duplicate blockedBy',
      },
      {
        name: 'unknown dependency',
        todos: [todo('a', 'A', 'pending', ['missing'])],
        error: 'unknown dependency',
      },
      {
        name: 'self dependency',
        todos: [todo('a', 'A', 'pending', ['a'])],
        error: 'must not depend on itself',
      },
      {
        name: 'cycle',
        todos: [
          todo('a', 'A', 'pending', ['b']),
          todo('b', 'B', 'pending', ['a']),
        ],
        error: 'must not contain a cycle',
      },
    ])('should reject a $name', ({ todos, error }) => {
      expect(tool.validateToolParams({ todos })).toContain(error);
    });
  });

  describe('execute', () => {
    /** Success message plus the changed-list reminder carrying `todos`. */
    function expectChangedReminder(result: ToolResult, todos: TodoItem[]) {
      expect(result.llmContent).toContain(MODIFIED);
      expect(result.llmContent).toContain('<system-reminder>');
      expect(result.llmContent).toContain('Your todo list has changed');
      expect(result.llmContent).toContain(JSON.stringify(todos));
    }

    function expectSessionFileWrite(body: unknown): void {
      expect(mockAtomicWrite).toHaveBeenCalledWith(
        expect.stringContaining('test-session-123.json'),
        body,
        { encoding: 'utf-8' },
      );
    }

    it('should create new todos file when none exists', async () => {
      const params: TodoWriteParams = {
        todos: [
          todo('1', 'Task 1', 'pending'),
          todo('2', 'Task 2', 'in_progress'),
        ],
      };
      noTodoFile();
      writesSucceed();

      const result = await runInPrompt(params);

      expectChangedReminder(result, params.todos);
      expect(result.returnDisplay).toMatchObject({
        type: 'todo_list',
        planId: expect.any(String),
        todos: [
          todo('1', 'Task 1', 'pending'),
          todo('2', 'Task 2', 'in_progress'),
        ],
      });
      expectSessionFileWrite(expect.stringContaining('"todos"'));
      expect(written()).toMatchObject({
        planId: expect.any(String),
        todos: params.todos,
      });
      expect(mockConfig.setActiveTodoReminder).toHaveBeenCalledWith(
        'todo-prompt',
        expect.stringContaining('Task 1'),
      );
    });

    it('should retain the plan ID while an active plan is revised', async () => {
      storedTodos({
        planId: 'plan-1',
        todos: [todo('1', 'Task', 'in_progress')],
      });
      writesSucceed();

      const result = await run({ todos: [todo('1', 'Task', 'completed')] });

      expect(result.returnDisplay).toMatchObject({ planId: 'plan-1' });
      expect(written()).toMatchObject({ planId: 'plan-1' });
    });

    it('should retain the plan ID for a repeated terminal snapshot', async () => {
      storedTodos({
        planId: 'finished-plan',
        todos: [todo('1', 'Done', 'completed')],
      });

      const result = await runInPrompt({
        todos: [todo('1', 'Done', 'completed')],
      });

      // Identical todos → no-op short-circuit, no write
      expect(mockAtomicWrite).not.toHaveBeenCalled();
      expect(result.returnDisplay).toMatchObject({
        planId: 'finished-plan',
        unchanged: true,
      });
      expect(mockConfig.setActiveTodoReminder).toHaveBeenCalledWith(
        'todo-prompt',
        undefined,
      );
    });

    it('should short-circuit with unchanged flag when todos are identical', async () => {
      const existingTodos = [
        todo('1', 'Task 1', 'in_progress'),
        todo('2', 'Task 2', 'pending'),
      ];
      storedTodos({ planId: 'plan-abc', todos: existingTodos });

      const result = await runInPrompt({ todos: existingTodos });

      // No file write or hooks should fire
      expect(mockAtomicWrite).not.toHaveBeenCalled();
      expect(mockFs.mkdir).not.toHaveBeenCalled();
      // Display signals unchanged to UI layer
      expect(result.returnDisplay).toMatchObject({
        type: 'todo_list',
        planId: 'plan-abc',
        todos: existingTodos,
        changes: { created: [], completed: [] },
        unchanged: true,
      });
      // LLM content tells model no change occurred
      expect(result.llmContent).toContain('already up to date');
      expect(result.llmContent).toContain('No changes were needed');
      expect(result.llmContent).not.toContain('modified successfully');
      expect(mockConfig.setActiveTodoReminder).toHaveBeenCalledWith(
        'todo-prompt',
        expect.stringContaining('Task 1'),
      );
    });

    it('should not fire hooks on no-op todo_write', async () => {
      const existingTodos = [todo('1', 'Task 1', 'pending')];
      const hooks = withHooks();
      storedTodos({ todos: existingTodos });

      await run({ todos: existingTodos });

      expect(hooks.fireTodoCreatedEvent).not.toHaveBeenCalled();
      expect(hooks.fireTodoCompletedEvent).not.toHaveBeenCalled();
    });

    /** A user edit whose `modified_content` holds `todos`, over a stored plan. */
    function runUserEdit(todos: TodoItem[]) {
      storedTodos({
        planId: 'plan-abc',
        todos: [todo('1', 'Task 1', 'in_progress')],
      });
      return run({
        todos: [],
        modified_by_user: true,
        modified_content: JSON.stringify({ todos }),
      });
    }

    it('should short-circuit with unchanged flag when modified_by_user yields identical todos', async () => {
      const result = await runUserEdit([todo('1', 'Task 1', 'in_progress')]);

      expect(mockAtomicWrite).not.toHaveBeenCalled();
      expect(result.returnDisplay).toMatchObject({ unchanged: true });
    });

    it('should return an error result if modified_content has invalid parsed todos', async () => {
      // Parsing an invalid todo list (empty content)
      const result = await runUserEdit([todo('1', '', 'pending')]);

      expect(mockAtomicWrite).not.toHaveBeenCalled();
      // execute catches validation errors and returns an error string
      expect(result.returnDisplay).toContain('non-empty "content"');
    });

    /** Writes `todos` over the completed plan `finished-plan`: a new plan starts. */
    async function expectNewPlanAfter(stored: TodoItem[], todos: TodoItem[]) {
      storedTodos({ planId: 'finished-plan', todos: stored });
      writesSucceed();
      const result = await run({ todos });
      const display = result.returnDisplay as { planId?: string };
      expect(display.planId).toEqual(expect.any(String));
      expect(display.planId).not.toBe('finished-plan');
    }

    it('should start a new plan after the previous plan completed', async () => {
      await expectNewPlanAfter(
        [
          todo('prepare', 'Prepare', 'completed'),
          todo('ship', 'Done', 'completed', ['prepare']),
        ],
        [todo('ship', 'New', 'pending')],
      );
      expect(written().todos).toEqual([
        { id: 'ship', content: 'New', status: 'pending' },
      ]);
    });

    it('should start a new plan for a distinct all-completed snapshot', async () => {
      await expectNewPlanAfter(
        [todo('1', 'Done', 'completed')],
        [todo('1', 'Already done', 'completed')],
      );
    });

    it('should clear persisted plan identity while identifying the cleared plan', async () => {
      storedTodos({
        planId: 'plan-to-clear',
        todos: [todo('1', 'Task', 'in_progress')],
      });
      writesSucceed();

      const result = await run({ todos: [] });

      expect(result.returnDisplay).toMatchObject({
        type: 'todo_list',
        planId: 'plan-to-clear',
        todos: [],
      });
      expect(written()).not.toHaveProperty('planId');
    });

    it('bounds the active Todo reminder', async () => {
      noTodoFile();
      writesSucceed();

      await runInPrompt({
        todos: [todo('1', 'x'.repeat(5000), 'in_progress')],
      });

      const reminder = lastReminder();
      expect(reminder).toContain('[truncated]');
      expect(reminder?.length).toBeLessThan(1100);
    });

    it('skips active Todo reminder when no prompt id is active', async () => {
      noTodoFile();
      writesSucceed();

      const result = await run({ todos: [todo('1', 'Task 1', 'pending')] });

      expect(result.llmContent).toContain(MODIFIED);
      expect(mockConfig.setActiveTodoReminder).not.toHaveBeenCalled();
    });

    it('should replace todos with new ones', async () => {
      const params: TodoWriteParams = {
        todos: [
          todo('1', 'Updated Task', 'completed'),
          todo('2', 'New Task', 'pending'),
        ],
      };
      // Mock existing file
      storedTodos({ todos: [todo('1', 'Existing Task', 'completed')] });
      writesSucceed();

      const result = await runInPrompt(params);

      expectChangedReminder(result, params.todos);
      expect(result.returnDisplay).toMatchObject({
        type: 'todo_list',
        todos: [
          todo('1', 'Updated Task', 'completed'),
          todo('2', 'New Task', 'pending'),
        ],
      });
      expectSessionFileWrite(expect.stringMatching(/"Updated Task"/));
      const reminder = lastReminder();
      expect(reminder).toContain('New Task');
      expect(reminder).not.toContain('Updated Task');
    });

    it('preserves dependencies when a status update omits blockedBy', async () => {
      storedTodos({
        todos: [
          todo('prepare', 'Prepare', 'completed'),
          todo('ship', 'Ship', 'pending', ['prepare']),
          todo('note', 'Old note', 'pending', ['prepare']),
        ],
      });
      writesSucceed();

      await run({
        todos: [
          todo('prepare', 'Prepare', 'completed'),
          todo('ship', 'Ship', 'completed'),
          todo('note', 'Updated note', 'pending', []),
        ],
      });

      expect(written().todos).toContainEqual(
        expect.objectContaining({ id: 'ship', blockedBy: ['prepare'] }),
      );
      expect(written().todos).toContainEqual(
        expect.objectContaining({ id: 'note', blockedBy: [] }),
      );
    });

    it('drops preserved dependencies whose target the same update removes', async () => {
      storedTodos({
        todos: [
          todo('a', 'Task A', 'pending'),
          todo('b', 'Task B', 'pending', ['a']),
        ],
      });
      writesSucceed();

      // Dropping 'a' is a routine plan-shrinking edit. The preserved edge from
      // 'b' to 'a' must not be re-injected: before the fix this rejected the
      // ENTIRE call with 'references unknown dependency "a"' mid-execute and
      // wrote nothing.
      const result = await run({ todos: [todo('b', 'Task B', 'pending')] });

      expect(result.returnDisplay).toMatchObject({
        type: 'todo_list',
        todos: [{ id: 'b', blockedBy: [] }],
      });
      expect(written().todos).toEqual([
        { id: 'b', content: 'Task B', status: 'pending', blockedBy: [] },
      ]);
    });

    it('reverses a dependency chain instead of failing on a preserved cycle edge', async () => {
      storedTodos({
        todos: [
          todo('a', 'Task A', 'pending'),
          todo('b', 'Task B', 'pending', ['a']),
          todo('c', 'Task C', 'pending', ['b']),
        ],
      });
      writesSucceed();

      // Reversing the chain omits blockedBy on the new root 'c'. Preservation
      // re-injects the stale c->b edge because 'b' survives, which closes a
      // cycle with the incoming b->c edge. The call must fall back to the
      // edges the caller actually sent instead of rejecting the entire update
      // with 'must not contain a cycle' mid-execute.
      const result = await run({
        todos: [
          todo('a', 'Task A', 'pending', ['b']),
          todo('b', 'Task B', 'pending', ['c']),
          todo('c', 'Task C', 'pending'),
        ],
      });

      expect(result.llmContent).toContain(MODIFIED);
      expect(written().todos).toEqual([
        { id: 'a', content: 'Task A', status: 'pending', blockedBy: ['b'] },
        { id: 'b', content: 'Task B', status: 'pending', blockedBy: ['c'] },
        { id: 'c', content: 'Task C', status: 'pending' },
      ]);
    });

    it('marks structured output in Session Workflow context', async () => {
      setWorkflowConfig();
      storedTodos({
        todos: [
          todo('prepare', 'Prepare', 'pending'),
          todo('ship', 'Ship', 'pending', ['prepare']),
        ],
      });
      writesSucceed();

      const result = await run({
        todos: [
          todo('prepare', 'Prepare', 'completed'),
          todo('ship', 'Ship', 'pending'),
        ],
      });

      expect(result.returnDisplay).toMatchObject({ sessionWorkflow: true });
    });

    it('keeps the Session Workflow marker on an unchanged Todo list', async () => {
      const todos = [todo('prepare', 'Prepare', 'pending')];
      setWorkflowConfig();
      storedTodos({ todos });

      const result = await run({ todos });

      expect(result.returnDisplay).toMatchObject({
        unchanged: true,
        sessionWorkflow: true,
      });
    });

    /**
     * Writes `todos` in approval `mode` over the stored plan `revision.planId`
     * (holding `stored`) that the Session Workflow `revision` is bound to.
     */
    async function runUnderRevision(
      mode: ApprovalMode,
      revision: { planId: string; todoIds: string[]; approved?: true },
      stored: TodoItem[],
      todos: TodoItem[],
    ) {
      const clearRevision = vi.fn();
      setWorkflowConfig({
        getApprovalMode: vi.fn().mockReturnValue(mode),
        getSessionWorkflowPlanRevision: vi.fn().mockReturnValue({
          planId: revision.planId,
          sourceCallId: 'todo-call-1',
          todoIds: revision.todoIds,
          ...(revision.approved ? { approved: true } : {}),
        }),
        clearSessionWorkflowPlanRevision: clearRevision,
      });
      storedTodos({ planId: revision.planId, todos: stored });
      writesSucceed();
      const result = await run({ todos });
      return { clearRevision, display: result.returnDisplay };
    }

    // Approval is stamped on the revision by the approved exit_plan_mode
    // transition, not derived from the approval mode.
    const approved = (todoIds: string[]) => ({
      planId: 'approved-plan',
      todoIds,
      approved: true as const,
    });

    function expectWorkflowEnded(outcome: {
      clearRevision: ReturnType<typeof vi.fn>;
      display: ToolResult['returnDisplay'];
    }) {
      expect(outcome.clearRevision).toHaveBeenCalledOnce();
      expect(outcome.display).not.toMatchObject({ sessionWorkflow: true });
      expect((outcome.display as { planId?: string }).planId).not.toBe(
        'approved-plan',
      );
    }

    const firstAndSecond = (status: TodoItem['status']) => [
      todo('first', 'First', status),
      todo('second', 'Second', 'pending'),
    ];

    it('ends an approved Workflow when a new Todo plan starts', async () => {
      expectWorkflowEnded(
        await runUnderRevision(
          ApprovalMode.DEFAULT,
          approved(['finished']),
          [todo('finished', 'Finished', 'completed')],
          [todo('next', 'Next task', 'pending')],
        ),
      );
    });

    it('ends an approved Workflow when active Todo IDs change', async () => {
      expectWorkflowEnded(
        await runUnderRevision(
          ApprovalMode.DEFAULT,
          approved(['first', 'second']),
          firstAndSecond('in_progress'),
          [todo('replacement', 'Replacement', 'pending')],
        ),
      );
    });

    it('keeps an approved revision constraining membership under a PLAN-mode wrapper (R5-2)', async () => {
      // A subagent whose definition carries `approvalMode: plan` gets a Config
      // wrapper whose OWN approvalMode is PLAN while the plan revision is
      // session-global and already approved. Approval status must come from
      // the revision's stamp — not the wrapper's mode — so a divergent write
      // inside the wrapper still ends the stale workflow binding.
      expectWorkflowEnded(
        await runUnderRevision(
          ApprovalMode.PLAN,
          approved(['first', 'second']),
          firstAndSecond('in_progress'),
          [todo('intruder', 'Intruder', 'pending')],
        ),
      );
    });

    it('keeps a pending Workflow draft when PLAN-mode refinement changes Todo IDs', async () => {
      // The revision captured from the first plan emission is still pending
      // approval while the session is in PLAN mode; refining the draft's
      // membership is ordinary iteration and must neither clear the revision
      // nor strip the workflow marker from the refined plan.
      const { clearRevision, display } = await runUnderRevision(
        ApprovalMode.PLAN,
        { planId: 'draft-plan', todoIds: ['first', 'second'] },
        firstAndSecond('pending'),
        [...firstAndSecond('pending'), todo('third', 'Third', 'pending')],
      );

      expect(clearRevision).not.toHaveBeenCalled();
      expect(display).toMatchObject({ sessionWorkflow: true });
      // The draft keeps its identity so the approval stamps the refined plan.
      expect((display as { planId?: string }).planId).toBe('draft-plan');
    });

    it('should handle file write errors', async () => {
      noTodoFile();
      mockFs.mkdir.mockResolvedValue(undefined);
      mockAtomicWrite.mockRejectedValue(new Error('Write failed'));

      const result = await run({
        todos: [todo('1', 'Task 1', 'pending'), todo('2', 'Task 2', 'pending')],
      });

      expect(result.llmContent).toContain('Failed to modify todos');
      expect(result.llmContent).toContain('<system-reminder>');
      expect(result.llmContent).toContain('Todo list modification failed');
      expect(result.llmContent).toContain('Write failed');
      expect(result.returnDisplay).toContain('Error writing todos');
    });

    it('should handle empty todos array', async () => {
      writesSucceed();
      storedTodos({ todos: [todo('1', 'Old Task', 'pending')] });

      const result = await runInPrompt({ todos: [] });

      expect(result.llmContent).toContain('Todo list has been cleared');
      expect(result.llmContent).toContain('<system-reminder>');
      expect(result.llmContent).toContain('Your todo list is now empty');
      expect(result.llmContent).toContain('no pending tasks');
      expect(result.returnDisplay).toMatchObject({
        type: 'todo_list',
        todos: [],
      });
      expectSessionFileWrite(expect.stringContaining('"todos"'));
      expect(mockConfig.setActiveTodoReminder).toHaveBeenCalledWith(
        'todo-prompt',
        undefined,
      );
    });

    /** A validation hook blocked: nothing is written and `message` surfaces. */
    function expectBlocked(result: ToolResult, message: string): void {
      expect(mockAtomicWrite).not.toHaveBeenCalled();
      expect(result.llmContent).toContain(message);
      expect(result.returnDisplay).toBe(message);
    }

    it('should block todo creation when validation hook returns block', async () => {
      const hooks = withHooks(
        vi.fn().mockResolvedValue(hookResult('block', 'Creation denied')),
      );
      const params = { todos: [todo('1', 'Task 1', 'pending')] };
      noTodoFile();

      const result = await run(params);

      expect(hooks.fireTodoCreatedEvent).toHaveBeenCalledWith(
        '1',
        'Task 1',
        'pending',
        params.todos,
        HookPhase.Validation,
        mockAbortSignal,
      );
      expectBlocked(result, 'Todo creation blocked: Creation denied');
    });

    it('should block todo completion when validation hook returns block', async () => {
      const hooks = withHooks(
        vi.fn(),
        vi.fn().mockResolvedValue(hookResult('block', 'Completion denied')),
      );
      const params = { todos: [todo('1', 'Task 1', 'completed')] };
      storedTodos({ todos: [todo('1', 'Task 1', 'in_progress')] });

      const result = await run(params);

      expect(hooks.fireTodoCompletedEvent).toHaveBeenCalledWith(
        '1',
        'Task 1',
        'in_progress',
        params.todos,
        HookPhase.Validation,
        mockAbortSignal,
      );
      expectBlocked(result, 'Todo completion blocked: Completion denied');
    });

    it('should ignore postWrite block decisions after persistence', async () => {
      const hooks = withHooks(
        vi
          .fn()
          .mockResolvedValueOnce(hookResult('allow'))
          .mockResolvedValueOnce(hookResult('block', 'Ignored after write')),
      );
      const params = { todos: [todo('1', 'Task 1', 'pending')] };
      noTodoFile();
      writesSucceed();

      const result = await run(params);

      const args = (phase: HookPhase) =>
        [
          '1',
          'Task 1',
          'pending',
          params.todos,
          phase,
          mockAbortSignal,
        ] as const;
      expect(mockAtomicWrite).toHaveBeenCalled();
      expect(hooks.fireTodoCreatedEvent).toHaveBeenNthCalledWith(
        1,
        ...args(HookPhase.Validation),
      );
      expect(hooks.fireTodoCreatedEvent).toHaveBeenNthCalledWith(
        2,
        ...args(HookPhase.PostWrite),
      );
      expect(result.llmContent).toContain(MODIFIED);
    });

    it('should dispatch post-write completion hooks sequentially in list order for a batched completion', async () => {
      // Regression: a single todo_write can complete several items at once,
      // and post-write TodoCompleted hooks run side effects. They must fire one
      // at a time, in list order, so a shared stateful/external-sync hook
      // can't interleave across sibling items. (Promise.all would overlap.)
      const allow = hookResult('allow', undefined, 1);
      const postWriteOrder: string[] = [];
      let activePostWrite = 0;
      let maxConcurrentPostWrite = 0;
      withHooks(
        vi.fn().mockResolvedValue(allow),
        vi
          .fn()
          .mockImplementation(
            async (
              id: string,
              _content: string,
              _previousStatus: string,
              _todos: TodoItem[],
              phase: HookPhase,
            ) => {
              if (phase === HookPhase.PostWrite) {
                activePostWrite++;
                maxConcurrentPostWrite = Math.max(
                  maxConcurrentPostWrite,
                  activePostWrite,
                );
                // Yield to the event loop so overlapping dispatch would be
                // observable as maxConcurrentPostWrite > 1.
                await new Promise((resolve) => setTimeout(resolve, 5));
                postWriteOrder.push(id);
                activePostWrite--;
              }
              return allow;
            },
          ),
      );
      storedTodos({
        todos: [
          todo('1', 'Task 1', 'in_progress'),
          todo('2', 'Task 2', 'in_progress'),
        ],
      });
      mockAtomicWrite.mockResolvedValue(undefined);

      const result = await run({
        todos: [
          todo('1', 'Task 1', 'completed'),
          todo('2', 'Task 2', 'completed'),
        ],
      });

      expect(result.llmContent).toContain(MODIFIED);
      // Both completions ran their post-write side effects, in list order, and
      // never overlapped.
      expect(postWriteOrder).toEqual(['1', '2']);
      expect(maxConcurrentPostWrite).toBe(1);
    });

    it('should validate created todos concurrently and stop before writing when one blocks', async () => {
      let releaseSlowHook: (() => void) | undefined;
      const slowValidation = new Promise<AggregatedHookResult>((resolve) => {
        releaseSlowHook = () => resolve(hookResult('allow'));
      });
      const hooks = withHooks(
        vi
          .fn()
          .mockImplementationOnce(() => slowValidation)
          .mockResolvedValueOnce(hookResult('block', 'Second todo denied')),
      );
      noTodoFile();

      const executionPromise = run({
        todos: [todo('1', 'Task 1', 'pending'), todo('2', 'Task 2', 'pending')],
      });

      await vi.waitFor(() => {
        expect(hooks.fireTodoCreatedEvent).toHaveBeenCalledTimes(2);
      });

      releaseSlowHook?.();
      const result = await executionPromise;

      expect(mockAtomicWrite).not.toHaveBeenCalled();
      expect(result.llmContent).toContain(
        'Todo creation blocked: Second todo denied',
      );
    });

    it('should report success when postWrite hooks fail after persistence', async () => {
      withHooks(
        vi
          .fn()
          .mockResolvedValueOnce(hookResult('allow'))
          .mockRejectedValueOnce(new Error('Hook timeout')),
      );
      const params = { todos: [todo('1', 'Task 1', 'pending')] };
      noTodoFile();
      writesSucceed();

      const result = await run(params);

      expect(mockAtomicWrite).toHaveBeenCalled();
      expect(result.llmContent).toContain(MODIFIED);
      expect(result.llmContent).toContain(
        'Todos were persisted successfully, but post-write hooks failed with error: Hook timeout.',
      );
      expect(result.returnDisplay).toMatchObject({
        type: 'todo_list',
        todos: params.todos,
      });
    });

    it('should run postWrite hooks concurrently after persistence', async () => {
      let postWriteReleaseCount = 0;
      const postWriteStarted: string[] = [];
      const validationAllow = hookResult('allow');
      withHooks(
        vi
          .fn()
          .mockImplementation((id, _content, _status, _allTodos, phase) => {
            if (phase === HookPhase.Validation) {
              return Promise.resolve(validationAllow);
            }

            postWriteStarted.push(id as string);
            return new Promise<AggregatedHookResult>((resolve) => {
              setTimeout(() => {
                postWriteReleaseCount += 1;
                resolve(hookResult('allow'));
              }, 0);
            });
          }),
      );
      noTodoFile();
      writesSucceed();

      const result = await run({
        todos: [todo('1', 'Task 1', 'pending'), todo('2', 'Task 2', 'pending')],
      });

      expect(mockAtomicWrite).toHaveBeenCalled();
      expect(postWriteStarted).toEqual(['1', '2']);
      expect(postWriteReleaseCount).toBe(2);
      expect(result.llmContent).toContain(MODIFIED);
    });
  });

  describe('tool properties', () => {
    it('should have correct tool name', () => {
      expect(TodoWriteTool.Name).toBe('todo_write');
      expect(tool.name).toBe('todo_write');
    });

    it('should have correct display name', () => {
      expect(tool.displayName).toBe('TodoList');
    });

    it('should have correct kind', () => {
      expect(tool.kind).toBe('think');
    });

    it('should describe selective, outcome-oriented task tracking', () => {
      expect(tool.description).toContain('complex, ambiguous, or multi-phase');
      expect(tool.description).toContain(
        'Do not use it for simple or single-step work',
      );
      expect(tool.description).toContain(
        'unless the user explicitly requests a todo list',
      );
      expect(tool.description).toContain('short and outcome-oriented');
      expect(tool.description).toContain(
        'Do not create a separate todo for every error, file, command, or minor edit',
      );
      expect(tool.description).not.toContain(
        'After receiving new instructions',
      );
      expect(tool.description).not.toContain('When in doubt, use this tool');
    });

    it('should have schema with required properties', () => {
      const schema = tool.schema;
      expect(schema.name).toBe('todo_write');
      expect(schema.parametersJsonSchema).toHaveProperty('properties.todos');
      expect(schema.parametersJsonSchema).not.toHaveProperty(
        'properties.merge',
      );
    });
  });

  describe('getDescription', () => {
    it('should return "Create todos" when no todos file exists', () => {
      // Mock existsSync to return false (file doesn't exist)
      mockFsSync.existsSync.mockReturnValue(false);

      const invocation = tool.build({
        todos: [todo('1', 'Test todo', 'pending')],
      });
      expect(invocation.getDescription()).toBe('Create todos');
    });

    it('should return "Update todos" when todos file exists', () => {
      // Mock existsSync to return true (file exists)
      mockFsSync.existsSync.mockReturnValue(true);

      const invocation = tool.build({
        todos: [todo('1', 'Updated todo', 'completed')],
      });
      expect(invocation.getDescription()).toBe('Update todos');
    });
  });
});

describe('TodoWriteTool – runtime output directory', () => {
  let tool: TodoWriteTool;
  let mockAbortSignal: AbortSignal;
  let mockConfig: Config;
  const originalRuntimeEnv = process.env['QWEN_RUNTIME_DIR'];

  /** Writes a one-item list to a fresh todo file; returns the write path. */
  async function writePath(): Promise<string> {
    noTodoFile();
    writesSucceed();
    await tool
      .build({ todos: [todo('1', 'Task 1', 'pending')] })
      .execute(mockAbortSignal);
    return mockAtomicWrite.mock.calls[0]?.[0] as string;
  }

  beforeEach(() => {
    mockConfig = {
      getSessionId: () => 'runtime-session',
      getHookSystem: () => undefined,
    } as unknown as Config;
    tool = new TodoWriteTool(mockConfig);
    mockAbortSignal = new AbortController().signal;
    Storage.setRuntimeBaseDir(null);
    delete process.env['QWEN_RUNTIME_DIR'];
    vi.clearAllMocks();
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    if (originalRuntimeEnv !== undefined) {
      process.env['QWEN_RUNTIME_DIR'] = originalRuntimeEnv;
    } else {
      delete process.env['QWEN_RUNTIME_DIR'];
    }
    vi.restoreAllMocks();
  });

  it('should write todos to custom runtime dir when setRuntimeBaseDir is set', async () => {
    const customRuntimeDir = path.resolve('custom', 'runtime');
    Storage.setRuntimeBaseDir(customRuntimeDir);

    // Verify the file path starts with the custom runtime dir
    const writtenPath = await writePath();
    expect(writtenPath).toContain(path.join(customRuntimeDir, 'todos'));
    expect(writtenPath).toContain('runtime-session.json');
  });

  it('should write todos to env var dir when QWEN_RUNTIME_DIR is set', async () => {
    const envRuntimeDir = path.resolve('env', 'runtime');
    process.env['QWEN_RUNTIME_DIR'] = envRuntimeDir;

    expect(await writePath()).toContain(path.join(envRuntimeDir, 'todos'));
  });

  it('should use default ~/.qwen path when no custom dir is configured', async () => {
    expect(await writePath()).toContain(path.join('.qwen', 'todos'));
  });

  it('should check file existence in custom runtime dir for getDescription', () => {
    const customRuntimeDir = path.resolve('custom', 'runtime');
    Storage.setRuntimeBaseDir(customRuntimeDir);
    mockFsSync.existsSync.mockReturnValue(false);

    const invocation = tool.build({ todos: [todo('1', 'Task', 'pending')] });

    // Verify existsSync was called with a path under the custom dir
    const checkedPath = mockFsSync.existsSync.mock.calls[0]?.[0] as string;
    expect(checkedPath).toContain(path.join(customRuntimeDir, 'todos'));
    expect(invocation.getDescription()).toBe('Create todos');
  });

  it('should list todo sessions from custom runtime dir', async () => {
    const customRuntimeDir = path.resolve('custom', 'runtime');
    Storage.setRuntimeBaseDir(customRuntimeDir);
    mockFs.readdir.mockResolvedValue([
      'a.json',
      'b.json',
      'README.md',
    ] as never);

    const sessions = await listTodoSessions();

    expect(mockFs.readdir).toHaveBeenCalledWith(
      path.join(customRuntimeDir, 'todos'),
    );
    expect(sessions).toEqual(['a', 'b']);
  });
});
