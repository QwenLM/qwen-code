/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PROMPT_ID,
  SESSION_ID,
  app,
  headers,
  settleTimeoutMs,
  state,
  store,
} from './hosted-harness-session.test-helper.js';
import { useRuntimeTakeover } from './hosted-harness-session-takeover.test-helper.js';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowStartCancelledError } from '@qwen-code/qwen-code-core/agents/runtime/workflow-runner.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';

describe('Hosted Harness Runtime turn takeover', () => {
  useRuntimeTakeover();

  describe('workflow launch prompts (#13803)', () => {
    const WORKFLOW_SCRIPT =
      'export const meta = { name: "audit", description: "d" };\nreturn { answer: 1 };';
    const WORKFLOW_PIN = {
      definitionId: 'workflow/audit',
      definitionRevision: 1,
      definitionDigest: createHash('sha256')
        .update(WORKFLOW_SCRIPT, 'utf8')
        .digest('hex'),
    };
    function workflowPrompt(
      overrides: Record<string, unknown> = {},
    ): Array<Record<string, unknown>> {
      return [
        {
          type: 'workflow_launch',
          definition: WORKFLOW_PIN,
          script: WORKFLOW_SCRIPT,
          ...overrides,
        },
      ];
    }
    const CHILD_LINEAGE = {
      parentSessionId: '10f4e2c2-93e6-4c26-b24a-b7c8b0f56aa1',
      rootSessionId: '10f4e2c2-93e6-4c26-b24a-b7c8b0f56aa1',
      parentChildRunId: 'run-1',
      depth: 1,
    };
    async function workflowApp(
      childShaped = true,
      withBroker = false,
      toolProfile?: string,
    ) {
      const server = await app(withBroker);
      const created = await headers(supertest(server).post('/session')).send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        ...(childShaped ? { lineage: CHILD_LINEAGE } : {}),
        ...(toolProfile === undefined ? {} : { toolProfile }),
      });
      expect(created.status).toBe(200);
      const authorize = (request: supertest.Test) =>
        headers(request).set(
          'X-Qwen-Client-Id',
          created.body.clientId as string,
        );
      const send = (prompt: Array<Record<string, unknown>>, promptId: string) =>
        authorize(supertest(server).post(`/session/${SESSION_ID}/prompt`)).send(
          {
            prompt,
            promptId,
            payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
          },
        );
      return { server, authorize, send };
    }

    it('admits a workflow launch block and runs it as the turn', async () => {
      const { server, authorize, send } = await workflowApp();
      const prompt = workflowPrompt({ args: { x: 1 } });
      const admitted = await send(prompt, PROMPT_ID);
      expect(admitted.status).toBe(202);
      await vi.waitFor(() => expect(state.workflow).toHaveBeenCalledTimes(1), {
        timeout: settleTimeoutMs(),
      });
      expect(state.workflow).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: SESSION_ID,
          launch: {
            definition: WORKFLOW_PIN,
            script: WORKFLOW_SCRIPT,
            args: { x: 1 },
          },
        }),
      );
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.model).not.toHaveBeenCalled();
      // The user record's message resource carries the one-line summary,
      // never the full launch payload journaling inline — the input
      // resource the input's digest names is where the payload lives.
      const transcript = await readFile(
        path.join(state.root, `${SESSION_ID}.jsonl`),
        'utf8',
      );
      // A fragment, not WORKFLOW_SCRIPT itself: the transcript JSON-escapes
      // the script body, so the whole string literal would never match.
      expect(transcript).not.toContain('export const meta =');
      const tree = await readdir(state.root, { recursive: true });
      const blobs = (
        await Promise.all(
          tree
            .filter((name) => !name.endsWith('.jsonl'))
            .map((name) =>
              readFile(path.join(state.root, name), 'utf8').catch(() => ''),
            ),
        )
      ).join('\n');
      expect(blobs).toContain('<workflow workflow/audit@1 sha256:');
      // R1-14: the turn commits the run's own settled outcome as its own
      // `managed-turn-result` resource, never as transcript text — a branch
      // that threw at commit time would ship an empty resource and pass the
      // watermark checks above. Reading the resource bodies makes that
      // removal visible.
      expect(blobs).toContain('Hello from workflow');
      // A same-body replay answers the same admission watermark.
      const replayed = await send(prompt, PROMPT_ID);
      expect(replayed.status).toBe(202);
      expect(replayed.body.lastEventId).toBe(admitted.body.lastEventId);
      expect(state.workflow).toHaveBeenCalledTimes(1);
      await authorize(supertest(server).delete(`/session/${SESSION_ID}`));
    });

    it('settles a registry-side cancel of the workflow start as a cancelled turn', async () => {
      const { server, authorize, send } = await workflowApp();
      state.workflow.mockRejectedValueOnce(new WorkflowStartCancelledError());
      const admitted = await send(
        workflowPrompt({ args: { x: 1 } }),
        PROMPT_ID,
      );
      expect(admitted.status).toBe(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      // The turn_result records a cancelled turn, never a failed one: the
      // registry torn down the start with this Turn's signal still live is
      // not a model or runtime failure.
      const lines = (
        await readFile(path.join(state.root, `${SESSION_ID}.jsonl`), 'utf8')
      )
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const turnSettled = lines.find(
        (entry) =>
          entry['type'] === 'system' &&
          entry['subtype'] === 'managed_session_event_v1' &&
          (
            entry['managedSession'] as
              | { kind?: string; payload?: Record<string, unknown> }
              | undefined
          )?.kind === 'turn.settled' &&
          (
            (
              entry['managedSession'] as {
                payload: Record<string, unknown>;
              }
            ).payload as Record<string, unknown>
          )['turnId'] === PROMPT_ID,
      );
      expect(turnSettled).toMatchObject({
        managedSession: {
          payload: { outcome: 'cancelled', stopReason: 'cancelled' },
        },
      });
      await authorize(supertest(server).delete(`/session/${SESSION_ID}`));
    });

    it('refuses malformed workflow blocks at the boundary', async () => {
      const { server, authorize, send } = await workflowApp();
      const malformed: Array<Array<Record<string, unknown>>> = [
        workflowPrompt({
          definition: { ...WORKFLOW_PIN, definitionDigest: 'not-hex' },
        }),
        workflowPrompt({
          definition: { ...WORKFLOW_PIN, definitionRevision: 0 },
        }),
        workflowPrompt({ script: '' }),
        workflowPrompt({ stray: 1 }),
        [...workflowPrompt(), { type: 'text', text: 'mixed' }],
      ];
      for (const prompt of malformed) {
        const response = await send(prompt, randomUUID());
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('invalid_hosted_prompt');
      }
      expect(state.workflow).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      await authorize(supertest(server).delete(`/session/${SESSION_ID}`));
    });

    // R1-14: the workflow launch's Turn never constructs the broker-backed
    // tool turn — its work is the runner's own dispatch; a missing guard
    // would let the harness fabricate a broker-backed tool turn for the
    // workflow prompt, invoking the same broker warm the text path calls.
    it('runs a workflow launch without ever warming the Session broker', async () => {
      const warm = vi
        .spyOn(HostedWorkspaceBroker.prototype, 'warm')
        .mockResolvedValue(undefined);
      // A tool-profiled Session: only the launch itself, never a missing
      // profile, keeps the broker-backed tool turn away (#13858 R2-8).
      const { server, authorize, send } = await workflowApp(
        true,
        true,
        'hosted-workspace-shell/1',
      );
      const admitted = await send(workflowPrompt(), PROMPT_ID);
      expect(admitted.status).toBe(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      expect(state.workflow).toHaveBeenCalledTimes(1);
      expect(state.model).not.toHaveBeenCalled();
      expect(warm).not.toHaveBeenCalled();
      await authorize(supertest(server).delete(`/session/${SESSION_ID}`));
    });

    // #13803: a workflow_launch block names work outside any managed
    // record, so it is mint-able only by the control plane's own child
    // creation — every other shape keeps the old refusal.
    it('refuses a workflow launch on a session without child lineage', async () => {
      const { server, authorize, send } = await workflowApp(false);
      const response = await send(workflowPrompt(), randomUUID());
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_hosted_prompt');
      expect(state.workflow).not.toHaveBeenCalled();
      expect(state.model).not.toHaveBeenCalled();
      await authorize(supertest(server).delete(`/session/${SESSION_ID}`));
    });

    it('refuses a workflow launch once the child Session has any input', async () => {
      const { server, authorize, send } = await workflowApp();
      // The child's own creation turn is text; after it settles, the
      // route never admits a workflow_launch block again.
      const first = [{ type: 'text', text: 'the creation turn is text' }];
      const admitted = await send(first, randomUUID());
      expect(admitted.status).toBe(202);
      await vi.waitFor(
        async () => {
          const status = await authorize(
            supertest(server).get(`/session/${SESSION_ID}/status`),
          );
          expect(status.body.hasActivePrompt).toBe(false);
        },
        { timeout: settleTimeoutMs() },
      );
      const response = await send(workflowPrompt(), randomUUID());
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_hosted_prompt');
      expect(state.workflow).not.toHaveBeenCalled();
      expect(state.model).toHaveBeenCalledTimes(1);
      await authorize(supertest(server).delete(`/session/${SESSION_ID}`));
    });
  });
});
