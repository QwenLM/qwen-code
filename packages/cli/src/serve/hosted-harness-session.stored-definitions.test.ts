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
  listeners,
  settleTimeoutMs,
  state,
  store,
} from './hosted-harness-session.test-helper.js';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { HostedWorkspaceBroker } from './hosted-workspace-broker.js';

describe('Hosted Harness stored definitions', () => {
  beforeEach(async () => {
    state.root = await mkdtemp(path.join(tmpdir(), 'hosted-harness-test-'));
    state.model.mockReset();
    state.model.mockImplementation(async () => ({
      text: 'hello back',
      model: 'test-model',
    }));
  });
  afterEach(async () => {
    await Promise.all(
      [...listeners].map((listener) =>
        Promise.race([
          headers(supertest(listener).delete(`/session/${SESSION_ID}`)),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]),
      ),
    );
    vi.restoreAllMocks();
    await rm(state.root, {
      recursive: true,
      force: true,
      // A wake pump's final writes can still be in flight at teardown.
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  it('creates and cold-loads a custom public Shell definition with base Hooks and no extension selection', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'release').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    const server = await app(true);
    const request = {
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-shell/1',
      publicChildAgentsVersion: 1,
      lifecycleProtocolVersion: 2,
      agentDefinition: {
        agentId: `agent_${'a'.repeat(32)}`,
        revision: '1',
        digest: 'b'.repeat(64),
      },
      hookCatalog: {
        catalogId: 'deployment',
        catalogRevision: 1,
        definitionDigest: 'c'.repeat(64),
      },
    };
    const created = await headers(supertest(server).post('/session')).send({
      ...request,
      sessionId: SESSION_ID,
      sessionScope: 'thread',
    });
    expect(created.status).toBe(200);
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .expect(204);
    const replacement = await app(true);
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({ ...request, passiveManagedRuntimeRecovery: true })
      .expect(200);
    expect(state.model).not.toHaveBeenCalled();
    await headers(supertest(replacement).post(`/session/${SESSION_ID}/detach`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .expect(204);
    const refused = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    ).send({ ...request, publicChildAgentsVersion: 0 });
    expect(refused.status).toBe(409);
  });

  it('keeps the public custom Shell gate closed on the legacy extension contract', async () => {
    const server = await app(true, undefined, false);
    await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        toolProfile: 'hosted-workspace-shell/1',
        publicChildAgentsVersion: 1,
        agentDefinition: {
          agentId: `agent_${'a'.repeat(32)}`,
          revision: '1',
          digest: 'b'.repeat(64),
        },
      })
      .expect(400);
  });

  it('pins creation-time Skills for the built-in agent across resident and cold loads', async () => {
    const server = await app(true);
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const sessionSkillsRef = await resources.publish(
      'managed-agent-skills',
      Buffer.from(
        JSON.stringify([
          {
            name: 'added',
            description: 'Added at creation',
            body: 'SESSION_CREATION_BODY',
            base_directory: 'docs',
          },
        ]),
      ),
    );
    const request = {
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      toolProfile: 'hosted-workspace-files/1',
      sessionSkillsRef,
    };
    await headers(supertest(server).post('/session')).send(request).expect(200);
    const load = (
      target: Awaited<ReturnType<typeof app>>,
      ref?: typeof sessionSkillsRef,
    ) =>
      headers(supertest(target).post(`/session/${SESSION_ID}/load`)).send({
        managedSessionStore: store(),
        sessionSkillsRef: ref,
        driveRuntimeRecovery: true,
      });
    await load(server).expect(409);
    await load(server, { ...sessionSkillsRef, digest: 'f'.repeat(64) }).expect(
      409,
    );
    const resident = await load(server, sessionSkillsRef).expect(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', resident.body.clientId)
      .expect(204);
    const replacement = await app(true);
    await load(replacement).expect(409);
    const loaded = await load(replacement, sessionSkillsRef).expect(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(replacement).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalled());
    const modelInput = state.model.mock.calls.at(-1)![0] as {
      agentDefinition?: unknown;
      skills?: import('./hosted-skill-catalog.js').HostedSkillCatalog;
    };
    expect(modelInput.agentDefinition).toBeUndefined();
    expect(modelInput.skills?.response({ skill: 'added' })).toContain(
      'SESSION_CREATION_BODY',
    );
    expect(modelInput.skills?.declaration()?.name).toBe('skill');
  });

  it('pins stored definitions across resident and cold loads and delivers instructions to the Turn', async () => {
    const server = await app();
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const instructionsRef = await resources.publish(
      'managed-agent-instructions',
      Buffer.from('D8_PINNED_INSTRUCTIONS'),
    );
    const identity = {
      agentId: `agent_${'a'.repeat(32)}`,
      revision: '1',
      digest: 'b'.repeat(64),
    };
    const definition = {
      ...identity,
      model: { id: 'configured' },
      instructionsRef,
    };
    const created = await headers(supertest(server).post('/session')).send({
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      agentDefinition: definition,
    });
    expect(created.status).toBe(200);
    const load = (agentDefinition?: typeof identity) =>
      headers(supertest(server).post(`/session/${SESSION_ID}/load`)).send({
        managedSessionStore: store(),
        agentDefinition,
        driveRuntimeRecovery: true,
      });
    expect((await load()).body.error).toBe('hosted_agent_definition_conflict');
    expect(
      (await load({ ...identity, digest: 'c'.repeat(64) })).body.error,
    ).toBe('hosted_agent_definition_conflict');
    expect((await load(identity)).status).toBe(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`)).expect(
      204,
    );
    const loaded = await load(identity);
    expect(loaded.status).toBe(200);
    const prompt = [{ type: 'text', text: 'hello' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(() => expect(state.model).toHaveBeenCalled());
    expect(state.model.mock.calls.at(-1)?.[0]).toMatchObject({
      agentDefinition: definition,
      agentInstructions: 'D8_PINNED_INSTRUCTIONS',
    });
    await vi.waitFor(
      async () => {
        const response = await headers(
          supertest(server).delete(`/session/${SESSION_ID}`),
        );
        expect(response.status).toBe(204);
      },
      { timeout: settleTimeoutMs() },
    );
  });

  it('loads published Skills from the saved resource after detach and rejects unbound Skill definitions', async () => {
    const server = await app(true);
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const skillsRef = await resources.publish(
      'managed-agent-skills',
      Buffer.from(
        JSON.stringify([
          {
            name: 'published',
            description: 'Published instructions',
            body: 'ORIGINAL_SKILL_BODY',
            base_directory: 'docs',
          },
        ]),
      ),
    );
    const identity = {
      agentId: `agent_${'a'.repeat(32)}`,
      revision: '1',
      digest: 'b'.repeat(64),
    };
    const definition = { ...identity, skillsRef };
    const request = {
      sessionId: SESSION_ID,
      sessionScope: 'thread',
      managedSessionStore: store(),
      agentDefinition: definition,
    };
    await headers(supertest(server).post('/session')).send(request).expect(400);
    const created = await headers(supertest(server).post('/session'))
      .send({ ...request, toolProfile: 'hosted-workspace-files/1' })
      .expect(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .expect(204);
    const replacement = await app(true);
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store(), agentDefinition: identity })
      .expect(200);
    state.model.mockImplementationOnce(async (input) => {
      const call = {
        name: 'skill',
        callId: 'call-skill',
        args: { skill: 'published' },
        isClientInitiated: false,
        prompt_id: PROMPT_ID,
      };
      expect(await input.toolTurn!.declarations(input.signal)).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'skill' })]),
      );
      const result = await input.toolTurn!.execute(
        [call],
        [
          {
            functionCall: { name: call.name, id: call.callId, args: call.args },
          },
        ],
        'test-model',
        input.signal,
      );
      expect(JSON.stringify(result)).toContain('ORIGINAL_SKILL_BODY');
      expect(JSON.stringify(result)).toContain('docs');
      return { text: 'Skill loaded', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'Use the published skill' }];
    await headers(supertest(replacement).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );

    expect(state.model).toHaveBeenCalledOnce();
    await expect(state.model.mock.results[0].value).resolves.toMatchObject({
      text: 'Skill loaded',
    });
  });

  // #13753 I3: a snapshot child's read profile declares only read_file and
  // glob, so its Session takes no skill catalog: no instruction names a
  // skill tool that the profile would refuse, failing the Turn.
  it('gives a read-profile Session no skill catalog from its agent definition', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    const server = await app(true);
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const skillsRef = await resources.publish(
      'managed-agent-skills',
      Buffer.from(
        JSON.stringify([
          {
            name: 'published',
            description: 'Published instructions',
            body: 'ORIGINAL_SKILL_BODY',
            base_directory: 'docs',
          },
        ]),
      ),
    );
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        agentDefinition: {
          agentId: `agent_${'a'.repeat(32)}`,
          revision: '1',
          digest: 'b'.repeat(64),
          skillsRef,
        },
        toolProfile: 'hosted-workspace-read/1',
        childWorkspaces: true,
        childSnapshots: true,
      })
      .expect(200);
    state.model.mockImplementationOnce(async (input) => {
      expect((input as { skills?: unknown }).skills).toBeUndefined();
      expect(
        (await input.toolTurn!.declarations(input.signal)).map(
          (tool) => tool.name,
        ),
      ).toEqual(['read_file', 'glob']);
      return { text: 'read only', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'Review the change' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(state.model).toHaveBeenCalledOnce();
    await expect(state.model.mock.results[0].value).resolves.toMatchObject({
      text: 'read only',
    });
  });

  // #13905 (item 42): the drop is not create-only — a read-profile Session
  // loaded from its stored definition takes no skill catalog either, so a
  // regression that keeps the catalog on load is caught here.
  it('keeps a loaded read-profile Session without a skill catalog from its agent definition', async () => {
    vi.spyOn(HostedWorkspaceBroker.prototype, 'warm').mockResolvedValue();
    vi.spyOn(HostedWorkspaceBroker.prototype, 'acquire').mockResolvedValue();
    vi.spyOn(
      HostedWorkspaceBroker.prototype,
      'activeHoldRuntimeSessionIds',
    ).mockResolvedValue([]);
    const server = await app(true);
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const skillsRef = await resources.publish(
      'managed-agent-skills',
      Buffer.from(
        JSON.stringify([
          {
            name: 'published',
            description: 'Published instructions',
            body: 'ORIGINAL_SKILL_BODY',
            base_directory: 'docs',
          },
        ]),
      ),
    );
    const identity = {
      agentId: `agent_${'a'.repeat(32)}`,
      revision: '1',
      digest: 'b'.repeat(64),
    };
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        agentDefinition: { ...identity, skillsRef },
        toolProfile: 'hosted-workspace-read/1',
        childWorkspaces: true,
        childSnapshots: true,
      })
      .expect(200);
    await headers(supertest(server).delete(`/session/${SESSION_ID}`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .expect(204);
    const replacement = await app(true);
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({ managedSessionStore: store(), agentDefinition: identity })
      .expect(200);
    state.model.mockImplementationOnce(async (input) => {
      expect((input as { skills?: unknown }).skills).toBeUndefined();
      expect(
        (await input.toolTurn!.declarations(input.signal)).map(
          (tool) => tool.name,
        ),
      ).toEqual(['read_file', 'glob']);
      return { text: 'read only', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'Review the change' }];
    await headers(supertest(replacement).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', loaded.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
    expect(state.model).toHaveBeenCalledOnce();
    await expect(state.model.mock.results[0].value).resolves.toMatchObject({
      text: 'read only',
    });
  });

  it('recovers a large manual Skill call whose assistant committed before its response', async () => {
    const server = await app(true);
    const resources = LocalManagedSessionResourceStore.create({
      runtimeBaseDir: state.root,
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: SESSION_ID,
      },
    });
    const skillsRef = await resources.publish(
      'managed-agent-skills',
      Buffer.from(
        JSON.stringify([
          {
            name: 'published',
            description: 'Instructions',
            body: 'RECOVERED_ORIGINAL_SKILL' + 'x'.repeat(400 * 1024),
            model_invocable: false,
          },
        ]),
      ),
    );
    const identity = {
      agentId: `agent_${'a'.repeat(32)}`,
      revision: '1',
      digest: 'b'.repeat(64),
    };
    const created = await headers(supertest(server).post('/session'))
      .send({
        sessionId: SESSION_ID,
        sessionScope: 'thread',
        managedSessionStore: store(),
        agentDefinition: { ...identity, skillsRef },
        toolProfile: 'hosted-workspace-files/1',
      })
      .expect(200);
    const originalWrite = ManagedSessionRecordSink.prototype.write;
    const write = vi
      .spyOn(ManagedSessionRecordSink.prototype, 'write')
      .mockImplementation(async function (
        this: ManagedSessionRecordSink,
        record,
      ) {
        if (
          record.type === 'tool_result' &&
          record.message?.parts?.some(
            (part) => part.functionResponse?.name === 'skill',
          )
        )
          throw new Error('Simulated Skill response commit failure');
        return originalWrite.call(this, record);
      });
    state.model.mockImplementationOnce(async (input) => {
      const call = {
        name: 'skill',
        callId: 'call-recover-skill',
        args: { skill: 'published' },
        isClientInitiated: true,
        prompt_id: PROMPT_ID,
      };
      await input.toolTurn!.execute(
        [call],
        [
          {
            functionCall: { name: call.name, id: call.callId, args: call.args },
          },
        ],
        'test-model',
        input.signal,
      );
      return { text: 'unreached', model: 'test-model' };
    });
    const prompt = [{ type: 'text', text: 'Load instructions' }];
    await headers(supertest(server).post(`/session/${SESSION_ID}/prompt`))
      .set('X-Qwen-Client-Id', created.body.clientId)
      .send({
        prompt,
        promptId: PROMPT_ID,
        payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify(prompt)).digest('hex')}`,
      })
      .expect(202);
    // The slow-host settle budget, not vitest's 1 s default: this poll flipped
    // in CI on a loaded ecs host (#15579, run 40182849995) before the
    // recovery-blocked state landed.
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(server).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', created.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(true);
      },
      { timeout: settleTimeoutMs() },
    );
    write.mockRestore();
    await headers(supertest(server).post(`/session/${SESSION_ID}/detach`)).set(
      'X-Qwen-Client-Id',
      created.body.clientId,
    );
    let recovered: readonly unknown[] | undefined;
    state.model.mockImplementationOnce(async (input) => {
      recovered = input.resumeFromToolResults;
      return { text: 'continued', model: 'test-model' };
    });
    const replacement = await app(true);
    const loaded = await headers(
      supertest(replacement).post(`/session/${SESSION_ID}/load`),
    )
      .send({
        managedSessionStore: store(),
        agentDefinition: identity,
        driveRuntimeRecovery: true,
      })
      .expect(200);
    await vi.waitFor(
      () =>
        expect(JSON.stringify(recovered)).toContain('RECOVERED_ORIGINAL_SKILL'),
      { timeout: settleTimeoutMs() },
    );
    expect(JSON.stringify(recovered)).not.toContain('never ran');
    expect(JSON.stringify(recovered)).toContain('Tool output truncated.');
    expect(JSON.stringify(recovered).length).toBeLessThan(201000);
    await vi.waitFor(
      async () => {
        const status = await headers(
          supertest(replacement).get(`/session/${SESSION_ID}/status`),
        ).set('X-Qwen-Client-Id', loaded.body.clientId);
        expect(status.body.hasActivePrompt).toBe(false);
        expect(status.body.recoveryBlocked).toBe(false);
      },
      { timeout: settleTimeoutMs() },
    );
  });
});
