/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  extensionInstructionText,
  managedSkillCatalogEntry,
} from '@qwen-code/qwen-code-core/extension/managed-skill-content.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import { isManagedExtensionConfig } from '@qwen-code/qwen-code-core/managed-runtime/managed-config-install.js';
import {
  type ManagedExtensionEffectiveBundle,
  parseManagedExtensionApplyCommand,
  parseManagedExtensionEffectiveBundle,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-package.js';
import type { ManagedHookCatalogPin } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import { ManagedSessionConflictError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { ManagedSessionCommitRejectedError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-storage.js';
import type { Application, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';
import { HostedClientFilesSession } from '../hosted-client-files-session.js';
import { hostedChildExtensionApplyCommand } from '../hosted-extension-agent.js';
import {
  type HostedExtensionPackage,
  HostedExtensionRevisionConflict,
  HostedExtensionSession,
} from '../hosted-extension-session.js';
import { HOSTED_UUID } from '../hosted-file-history.js';
import type { HostedHarnessContract } from '../hosted-harness-contract.js';
import {
  hostedConfigScopedOwnerId,
  HostedHookInputConflictError,
  hostedHookOccurrenceId,
  HostedHookRecoveryRequiredError,
  HostedHookSession,
  parseHostedHookPin,
} from '../hosted-hook-session.js';
import {
  HOSTED_MCP_PROFILE,
  HostedMcpConflictError,
  HostedMcpConnectionQuotaError,
  HostedMcpRecoveryRequiredError,
  type HostedMcpServerPin,
  HostedMcpSession,
  parseHostedMcpServers,
} from '../hosted-mcp-session.js';
import {
  HostedMcpManager,
  parseHostedMcpCommand,
  readHostedMcpSettings,
} from '../hosted-mcp-settings.js';
import { HostedSkillCatalog } from '../hosted-skill-catalog.js';
import {
  HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
  HostedWorkspaceBrokerRejection,
} from '../hosted-workspace-broker.js';
import {
  HOSTED_WORKSPACE_SHELL_PROFILE_V3,
  isHostedWorkspaceExternalProfile,
} from '../hosted-workspace-profiles.js';
import { runHostedLifecycleHook } from './lifecycle-routes.js';
import {
  error,
  hostedTurnBusyReason,
  identity,
  object,
} from './session-http.js';
import type { HostedSession } from './session-state.js';
import { settleCancelledHookTurn } from './turn-cancellation.js';

/**
 * Lifts a Session's recovery block. The named reason belongs to the block,
 * so it is cleared with it here rather than by hand at each lift site.
 */
export function selectExtensionCatalog(
  session: HostedSession,
  bundle: ManagedExtensionEffectiveBundle,
  packages: readonly HostedExtensionPackage[],
): void {
  session.baseSkills ??= session.skills ?? new HostedSkillCatalog([]);
  session.skills = extensionSkillCatalog(session.baseSkills, packages);
  session.extensionBundle = bundle;
  session.extensionPackages = packages;
  session.extensionContext = packages
    .flatMap((entry) =>
      entry.contributions.context.map(
        (context) =>
          `<extension_context source="extension://${entry.extensionId}/${context.path}">\n${extensionInstructionText(context.body, entry.extensionId)}\n</extension_context>`,
      ),
    )
    .join('\n\n');
}

function extensionSkillCatalog(
  base: HostedSkillCatalog | undefined,
  packages: readonly HostedExtensionPackage[],
): HostedSkillCatalog {
  const agents = packages.flatMap((entry) =>
    entry.contributions.agents.map((agent) => agent.name),
  );
  if (new Set(agents).size !== agents.length)
    throw new Error('Extension agent names conflict.');
  return new HostedSkillCatalog(
    [
      ...(base?.entries() ?? []),
      ...packages.flatMap((entry) =>
        entry.contributions.skills.map((skill) =>
          managedSkillCatalogEntry(skill, entry.extensionId),
        ),
      ),
    ],
    packages.flatMap((entry) =>
      entry.contributions.commands.map((command) => ({
        ...command,
        extensionId: entry.extensionId,
      })),
    ),
  );
}

export function extensionAgentsOf(session: HostedSession) {
  const bundleRef = session.extensions?.activeBundleRef;
  if (!bundleRef || !session.extensionBundle) return [];
  return (session.extensionPackages ?? []).flatMap((entry) => {
    const member = session.extensionBundle!.packages.find(
      (member) => member.pin.extensionId === entry.extensionId,
    )!;
    return entry.contributions.agents.map((agent) => ({
      name: agent.name,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.tools ? { tools: agent.tools } : {}),
      ...(agent.disallowedTools
        ? { disallowedTools: agent.disallowedTools }
        : {}),
      descriptor: {
        configRevision: session.extensionBundle!.configRevision,
        bundleRef,
        pin: member.pin,
        contributionsRef: member.contributionsRef,
        agentName: agent.name,
        toolNames: [],
      },
    }));
  });
}

export async function extensionBootstrapIncomplete(
  session: HostedSession,
  manager: HostedExtensionSession,
): Promise<boolean> {
  if (!session.initialSelection && !session.publicChildExtensionAgent)
    return false;
  const active = await manager.active();
  return (
    !manager.activeBundleRef ||
    !active ||
    active.configRevision < 1 ||
    (!!session.publicChildExtensionAgent &&
      !isDeepStrictEqual(
        active.packages.map((entry) => entry.pin),
        session.extensionAgentPins,
      ))
  );
}

export function createHostedExtensionsManager(
  brokerOptions: HostedWorkspaceBrokerOptions | undefined,
  contract: HostedHarnessContract,
) {
  return async function extensionsManager(
    session: HostedSession,
    childBootstrap = false,
  ): Promise<HostedExtensionSession> {
    if (
      !brokerOptions ||
      session.foregroundOnly ||
      ((session.childDepth ?? 0) !== 0 &&
        !(childBootstrap && session.publicChildExtensionAgent)) ||
      ![
        'hosted-workspace-shell/1',
        HOSTED_WORKSPACE_SHELL_PROFILE_V3,
        'hosted-workspace-shell/4',
        HOSTED_MCP_PROFILE,
      ].includes(session.toolProfile ?? '') ||
      !contract.lifecycleV2Profiles?.includes(session.toolProfile!)
    )
      throw new Error('Hosted extension management is unavailable.');
    if (session.extensions) return session.extensions;
    const head = session.managed.authority.domainRecord('config_install');
    const config =
      head &&
      JSON.parse(
        (await session.managed.resources.read(head.recordRef)).toString('utf8'),
      );
    const unified = config && isManagedExtensionConfig(config);
    const legacy = unified ? [] : await readHostedMcpSettings(session.managed);
    const baseMcp = session.definition?.['mcpServers'];
    const options = {
      ...brokerOptions,
      lifecycleAuthority: () => session.lifecycle,
    };
    const manager = new HostedExtensionSession(
      session.managed,
      options,
      {
        mcpRevision: legacy.at(-1)?.revision ?? 0,
        mcpServers:
          legacy.at(-1)?.servers ??
          (baseMcp === undefined
            ? []
            : parseHostedMcpServers(baseMcp).map((pin) => ({
                ...pin,
                state: 'enabled' as const,
              }))),
        hookCatalog:
          session.hooks?.selectedPin ??
          (session.definition?.['hookCatalog'] === undefined
            ? null
            : parseHostedHookPin(session.definition['hookCatalog'])),
      },
      {
        validate: (packages) => {
          extensionSkillCatalog(session.baseSkills ?? session.skills, packages);
          if (
            (session.childDepth ?? 0) === 0 &&
            session.publicChildAgentsVersion !== 1 &&
            packages.some((entry) => entry.contributions.agents.length > 0)
          )
            throw new Error(
              'Extension agents require the public child Session profile.',
            );
        },
        drain: async (bundle, forceMcpServerId) => {
          if (
            session.hooks &&
            !isDeepStrictEqual(session.hooks.selectedPin, bundle.hookCatalog)
          ) {
            await session.hooks.close();
            session.hooks = undefined;
          }
          if (bundle.mcpServers.length || session.hooks)
            await session.mcp?.drainForExtensionConfiguration(
              bundle.mcpServers,
              forceMcpServerId,
            );
          else if (session.mcp) {
            await session.mcp.close();
            session.mcp = undefined;
          }
        },
        enable: async (bundle, packages, operationId) => {
          const ownerId = hostedConfigScopedOwnerId(
            session.managed.authority.sessionHeader.sessionKey,
            bundle.configRevision,
          );
          if (bundle.mcpServers.length && !session.mcp) {
            const broker =
              session.hooks?.broker ??
              new HostedWorkspaceBroker(
                options,
                session.managed.authority.sessionHeader.sessionKey,
                ownerId,
              );
            // A non-terminal discard can leave drained rows under a superseded
            // owner; release them before constructing so a live off->on->off->on
            // toggle does not accumulate owners.size>1 (R15-3, the live-path
            // counterpart of the cold-load sweep). The active owner's own drained
            // rows are untouched, so a failed apply is never stranded.
            await HostedMcpSession.releaseSupersededDrained(
              session.managed,
              ownerId,
            );
            session.mcp = new HostedMcpSession(
              options,
              session.managed,
              bundle.mcpServers,
              undefined,
              broker,
              true,
            );
            if (session.hooks?.broker === broker)
              session.hooks.delegateBrokerToMcp();
          }
          const extensionBroker =
            session.mcp?.broker ??
            new HostedWorkspaceBroker(
              options,
              session.managed.authority.sessionHeader.sessionKey,
              ownerId,
            );
          if (
            session.hooks &&
            session.hooks.broker.runtimeSessionId !==
              extensionBroker.runtimeSessionId
          ) {
            // The owner moved (configRevision changed) while the Hook catalog
            // pin stayed the same, so drain kept this session. Close it to
            // release its mount claim and let the rebuild below bind the new
            // owner. Swapping the broker under a held mount would orphan the
            // claim, and refusing the swap would park a previously-valid apply
            // at recovery_required.
            await session.hooks.close();
            session.hooks = undefined;
          }
          if (bundle.hookCatalog && !session.hooks) {
            session.hooks = new HostedHookSession(
              options,
              session.managed,
              bundle.hookCatalog,
              session.mcp?.broker,
              () => session.lifecycleProtocolVersion === 2,
              ownerId,
            );
          }
          if (
            bundle.hookCatalog &&
            session.hooks &&
            (!isDeepStrictEqual(
              session.hooks.selectedPin,
              bundle.hookCatalog,
            ) ||
              session.managed.authority.extensionRecordsInDomain(
                'hook_registration',
              ).length === 0)
          )
            await session.hooks.configure(
              `extension-catalog-${operationId}-${bundle.configRevision}`,
              bundle.hookCatalog,
              session.managed.authority.extensionRecordsInDomain(
                'hook_registration',
              ).length,
            );
          await session.mcp?.enableExtensionConfiguration(
            bundle.mcpServers,
            operationId,
          );
          await session.hooks?.ensureReady();
          selectExtensionCatalog(session, bundle, packages);
        },
      },
    );
    await manager.open();
    session.extensions = manager;
    return manager;
  };
}

export type HostedExtensionsManager = ReturnType<
  typeof createHostedExtensionsManager
>;

export function registerHostedConfigurationRoutes({
  app,
  sessions,
  brokerOptions,
  contract,
  extensionsManager,
}: {
  app: Application;
  sessions: Map<string, HostedSession>;
  brokerOptions: HostedWorkspaceBrokerOptions | undefined;
  contract: HostedHarnessContract;
  extensionsManager: HostedExtensionsManager;
}): void {
  app.get('/session/:id/hooks', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.hooks) return error(res, 409, 'hosted_hooks_unavailable');
    const catalog = session.hooks.getCatalog();
    res.json({
      catalog: catalog
        ? {
            ...catalog,
            hooks: catalog.hooks.map(
              ({ config, handler: _handler, ...hook }) => ({
                ...hook,
                type: config.type,
              }),
            ),
          }
        : null,
    });
  });

  app.post('/session/:id/client-files', async (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    const body = object(req.body);
    const action = body?.['action'];
    if (action === 'unregister') {
      // Unregister is admitted during a Turn and teardown: it only drops the
      // catalog and connection so later Turns stop advertising tools whose
      // binding is gone. Only register needs the idle/teardown gates. A stale
      // teardown carries the generation it closed; if a newer registration has
      // since installed, leave that catalog alone.
      const files = session.clientFiles;
      const generation = body?.['generation'];
      if (
        files &&
        (typeof generation !== 'number' || files.generation === generation)
      ) {
        await files.unregister();
      }
      return res.json({ registered: false });
    }
    // Refuse register mid-teardown like the sibling mutation routes: the
    // registration would otherwise be installed after close cleared it and
    // before the session leaves the map, orphaning a relay client.
    if (session.mcpClosing) return error(res, 409, 'hosted_session_closing');
    if (session.mcpBusy || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    if (session.active || session.blocked)
      return error(res, 409, 'hosted_turn_active');
    if (action !== 'register')
      return error(res, 400, 'invalid_client_files_action');
    // A foregroundOnly, memory-only (no toolProfile), or external Session
    // never declares a client-files catalog — the Turn drops the lane or the
    // external branch never calls clientFilesDeclarations — so registering a
    // relay client would hold a connection for tools no Turn hands out while
    // the panel reports connected. Refuse like the sibling management lanes;
    // unregister above stays admitted in every state.
    if (
      session.foregroundOnly ||
      !session.toolProfile ||
      isHostedWorkspaceExternalProfile(session.toolProfile)
    )
      return error(res, 409, 'hosted_client_files_profile_unsupported');
    const serverId = body?.['serverId'];
    const generation = body?.['generation'];
    const url = body?.['url'];
    const token = body?.['token'];
    if (
      typeof serverId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(serverId) ||
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      typeof url !== 'string' ||
      typeof token !== 'string' ||
      token === ''
    )
      return error(res, 400, 'invalid_client_files_registration');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return error(res, 400, 'invalid_client_files_registration');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return error(res, 400, 'invalid_client_files_registration');
    session.clientFiles ??= new HostedClientFilesSession();
    try {
      const toolCount = await session.clientFiles.register({
        serverId,
        generation,
        url,
        token,
      });
      return res.json({ registered: true, generation, toolCount });
    } catch (cause) {
      return error(
        res,
        503,
        'client_files_relay_unavailable',
        undefined,
        cause instanceof Error ? cause.message : undefined,
      );
    }
  });

  app.post('/session/:id/hooks/operations', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.hooks) return error(res, 409, 'hosted_hooks_unavailable');
    if (
      session.active ||
      session.hooksBusy ||
      session.mcpBusy ||
      session.mcpRecovering ||
      session.blocked
    )
      return error(res, 409, 'hosted_turn_active');
    const body = object(req.body);
    const operationId = body?.['operationId'];
    const event = body?.['event'];
    const fields = object(body?.['input']);
    if (
      typeof operationId !== 'string' ||
      !HOSTED_UUID.test(operationId) ||
      (event !== HookEventName.Notification &&
        event !== HookEventName.UserPromptExpansion) ||
      !fields
    )
      return error(res, 400, 'invalid_hook_operation');
    if (
      (event === HookEventName.Notification &&
        (typeof fields['message'] !== 'string' ||
          typeof fields['notification_type'] !== 'string')) ||
      (event === HookEventName.UserPromptExpansion &&
        (typeof fields['command_name'] !== 'string' ||
          typeof fields['command_args'] !== 'string' ||
          typeof fields['prompt'] !== 'string'))
    )
      return error(res, 400, 'invalid_hook_input');
    if (
      session.hooks.hasPendingOperations &&
      !session.managed.authority.extensionRecord(
        'hook_execution',
        hostedHookOccurrenceId(event, operationId),
      )
    )
      return error(res, 409, 'hosted_hook_recovery_required');
    session.hooksBusy = true;
    const input =
      event === HookEventName.Notification
        ? {
            message: fields['message'],
            notification_type: fields['notification_type'],
          }
        : {
            command_name: fields['command_name'],
            command_args: fields['command_args'],
            prompt: fields['prompt'],
          };
    void runHostedLifecycleHook(session, event, operationId, input)
      .then(
        (output) => res.json({ operationId, output: output ?? null }),
        (cause) => {
          if (cause instanceof HostedHookInputConflictError)
            return error(res, 409, 'hosted_hook_operation_conflict');
          writeStderrLineSafe(
            cause instanceof HostedHookRecoveryRequiredError
              ? `qwen serve: Hosted Hook operation ${operationId} is recovery blocked: ${String(cause)}`
              : `qwen serve: Hosted Hook operation ${operationId} failed: ${String(cause)}`,
          );
          error(res, 503, 'hosted_hook_operation_failed');
        },
      )
      .finally(() => {
        session.hooksBusy = false;
      });
  });

  const hookStatus = (cancel: boolean) => (req: Request, res: Response) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.hooks) return error(res, 409, 'hosted_hooks_unavailable');
    void session.hooks
      .status(req.params['operationId'], cancel)
      .then(async (execution) => {
        if (execution.hookId !== '__plan__')
          await session.hooks!.status(execution.occurrenceId);
        if (!session.lifecycle) await settleCancelledHookTurn(session);
        res.json({
          operationId: execution.hookExecutionId,
          state: execution.run.state,
          execution: execution.run.execution,
          cancelRequested: execution.cancelRequested,
        });
      })
      .catch(() => error(res, 409, 'hosted_hook_recovery_required'));
  };
  app.get('/session/:id/hooks/operations/:operationId', hookStatus(false));
  app.post(
    '/session/:id/hooks/operations/:operationId/cancel',
    hookStatus(true),
  );

  app.post('/session/:id/hooks/registrations', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.hooks) return error(res, 409, 'hosted_hooks_unavailable');
    if (session.extensions?.enabled)
      return error(res, 409, 'hosted_extension_configuration_required');
    if (
      session.active ||
      session.hooksBusy ||
      session.mcpBusy ||
      session.mcpRecovering
    )
      return error(res, 409, 'hosted_turn_active');
    const body = object(req.body);
    const operationId = body?.['operationId'];
    const expectedRevision = body?.['expectedRevision'];
    let pin: ManagedHookCatalogPin;
    try {
      if (
        typeof operationId !== 'string' ||
        !HOSTED_UUID.test(operationId) ||
        !Number.isSafeInteger(expectedRevision) ||
        (expectedRevision as number) < 0
      )
        throw new Error('Invalid registration.');
      pin = parseHostedHookPin(body?.['catalog']);
    } catch {
      return error(res, 400, 'invalid_hook_registration');
    }
    session.hooksBusy = true;
    void session.hooks
      .configure(operationId as string, pin, expectedRevision as number)
      .then(
        () => res.json({ operationId, registered: true }),
        () => error(res, 409, 'hook_registration_failed'),
      )
      .finally(() => {
        session.hooksBusy = false;
      });
  });

  const mcpManager = (session: HostedSession) => {
    if (
      !brokerOptions ||
      session.foregroundOnly ||
      (session.childDepth ?? 0) !== 0 ||
      ![
        'hosted-workspace-shell/1',
        HOSTED_WORKSPACE_SHELL_PROFILE_V3,
        'hosted-workspace-shell/4',
        HOSTED_MCP_PROFILE,
      ].includes(session.toolProfile ?? '') ||
      !contract.lifecycleV2Profiles?.some(
        (profile) => profile === session.toolProfile,
      )
    )
      throw new Error('Hosted MCP management is unavailable.');
    const pins = session.definition?.['mcpServers'];
    return new HostedMcpManager(
      session.managed,
      pins === undefined ? [] : parseHostedMcpServers(pins),
      { ...brokerOptions, lifecycleAuthority: () => session.lifecycle },
      session.mcp,
      () => session.hooks?.broker,
    );
  };

  app.get('/session/:id/extensions/management', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    void extensionsManager(session, !!session.publicChildExtensionAgent)
      .then(async (manager) => res.json(await manager.snapshot()))
      .catch(() => error(res, 409, 'hosted_extension_management_unavailable'));
  });

  function skillBroker(
    session: HostedSession,
    owner?: { bindingId: string; generation: string },
  ) {
    if (
      !brokerOptions ||
      session.foregroundOnly ||
      (session.childDepth ?? 0) !== 0 ||
      ![
        'hosted-workspace-shell/1',
        HOSTED_WORKSPACE_SHELL_PROFILE_V3,
        'hosted-workspace-shell/4',
        HOSTED_MCP_PROFILE,
      ].includes(session.toolProfile ?? '') ||
      !contract.lifecycleV2Profiles?.includes(session.toolProfile!)
    )
      throw new Error('hosted_skill_import_unsupported');
    const broker = new HostedWorkspaceBroker(
      { ...brokerOptions, lifecycleAuthority: () => session.lifecycle },
      session.managed.authority.sessionHeader.sessionKey,
      'skill-management',
    );
    if (owner)
      broker.expectExtensionRuntime({
        runtimeBindingId: owner.bindingId,
        generation: owner.generation,
      });
    return broker;
  }

  function skillOwner(value: unknown): {
    bindingId: string;
    generation: string;
  } {
    const owner = object(value);
    if (
      !owner ||
      Object.keys(owner).sort().join(',') !== 'bindingId,generation' ||
      typeof owner['bindingId'] !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(owner['bindingId']) ||
      typeof owner['generation'] !== 'string' ||
      !/^[1-9][0-9]{0,18}$/u.test(owner['generation']) ||
      BigInt(owner['generation']) > 2n ** 63n - 1n
    )
      throw new Error('invalid_skill_owner');
    return { bindingId: owner['bindingId'], generation: owner['generation'] };
  }

  app.get('/session/:id/extensions/skills/candidates', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    void (async () => {
      const broker = skillBroker(session);
      const result = await broker.skillControl({
        kind: 'extension-skill-candidates',
        operationId: randomUUID(),
      });
      if (!broker.runtime || !Array.isArray(result['candidates']))
        throw new Error('Invalid Skill response.');
      res.json({
        sessionId: session.managed.authority.sessionHeader.sessionKey.sessionId,
        owner: {
          bindingId: broker.runtime.bindingId,
          generation: broker.runtime.generation,
        },
        candidates: result['candidates'],
      });
    })().catch((cause) =>
      error(
        res,
        409,
        cause instanceof HostedWorkspaceBrokerRejection &&
          typeof cause.code === 'string'
          ? cause.code
          : 'hosted_skill_source_unavailable',
      ),
    );
  });

  app.post('/session/:id/extensions/skills/snapshot', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (
      session.active ||
      session.hooksBusy ||
      session.mcpBusy ||
      session.mcpRecovering ||
      session.blocked
    )
      return error(res, 409, 'hosted_turn_active');
    const body = object(req.body);
    if (
      !body ||
      Object.keys(body).sort().join(',') !== 'digest,operationId,owner,path' ||
      typeof body['operationId'] !== 'string' ||
      !HOSTED_UUID.test(body['operationId']) ||
      typeof body['path'] !== 'string' ||
      typeof body['digest'] !== 'string'
    )
      return error(res, 400, 'invalid_skill_snapshot');
    let owner: { bindingId: string; generation: string };
    try {
      owner = skillOwner(body['owner']);
    } catch {
      return error(res, 400, 'invalid_skill_snapshot');
    }
    session.mcpBusy = true;
    void (async () => {
      const broker = skillBroker(session, owner);
      const result = await broker.skillControl({
        kind: 'extension-skill-snapshot',
        operationId: body['operationId'] as string,
        path: body['path'] as string,
        digest: body['digest'] as string,
      });
      res.json({
        sessionId: session.managed.authority.sessionHeader.sessionKey.sessionId,
        owner,
        ...result,
      });
    })()
      .catch((cause) =>
        error(
          res,
          409,
          cause instanceof HostedWorkspaceBrokerRejection &&
            typeof cause.code === 'string'
            ? cause.code
            : 'hosted_skill_source_unavailable',
        ),
      )
      .finally(() => {
        session.mcpBusy = false;
      });
  });

  app.get(
    '/session/:id/extensions/skills/archives/:preparationId',
    (req, res) => {
      const session = identity(req, sessions);
      if (!session) return error(res, 404, 'hosted_session_not_found');
      void (async () => {
        const owner = skillOwner({
          bindingId: req.query['bindingId'],
          generation: req.query['generation'],
        });
        const operationId = req.query['operationId'];
        const offset = req.query['offset'];
        if (
          typeof operationId !== 'string' ||
          !HOSTED_UUID.test(operationId) ||
          typeof offset !== 'string' ||
          !/^(?:0|[1-9][0-9]*)$/u.test(offset) ||
          !Number.isSafeInteger(Number(offset))
        )
          throw new Error('Invalid Skill chunk request.');
        const broker = skillBroker(session, owner);
        const result = await broker.skillControl({
          kind: 'extension-skill-archive',
          operationId,
          preparationId: String(req.params['preparationId']),
          offset: Number(offset),
        });
        res.json({
          sessionId:
            session.managed.authority.sessionHeader.sessionKey.sessionId,
          owner,
          ...result,
        });
      })().catch((cause) =>
        error(
          res,
          409,
          cause instanceof HostedWorkspaceBrokerRejection &&
            typeof cause.code === 'string'
            ? cause.code
            : 'hosted_skill_snapshot_unavailable',
        ),
      );
    },
  );

  app.get(
    '/session/:id/extensions/management/operations/:operationId',
    (req, res) => {
      const session = identity(req, sessions);
      if (!session) return error(res, 404, 'hosted_session_not_found');
      void extensionsManager(session, !!session.publicChildExtensionAgent)
        .then(async (manager) =>
          res.json(await manager.snapshot(req.params['operationId'])),
        )
        .catch(() => error(res, 404, 'hosted_extension_operation_not_found'));
    },
  );

  for (const action of ['apply', 'continue', 'recover-previous'] as const) {
    const path =
      action === 'apply'
        ? '/session/:id/extensions/management'
        : `/session/:id/extensions/management/operations/:operationId/${action}`;
    app.post(path, (req, res) => {
      const session = identity(req, sessions);
      if (!session) return error(res, 404, 'hosted_session_not_found');
      if (
        session.active ||
        session.hooksBusy ||
        session.mcpBusy ||
        session.mcpRecovering ||
        session.mcpClosing ||
        session.lifecycle ||
        session.recoveryCleanupOnly ||
        (action === 'apply' &&
          session.blocked &&
          !session.extensionBootstrapPending)
      )
        return error(res, 409, 'hosted_turn_active');
      let operationId: string;
      let command:
        | ReturnType<typeof parseManagedExtensionApplyCommand>
        | undefined;
      try {
        if (action === 'apply') {
          command = parseManagedExtensionApplyCommand(
            object(req.body)?.['command'] ?? req.body,
          );
          operationId = command.operationId;
        } else {
          operationId = req.params['operationId'];
          if (!HOSTED_UUID.test(operationId))
            throw new Error('Invalid operation.');
        }
      } catch {
        return error(res, 400, 'invalid_extension_command');
      }
      session.mcpBusy = true;
      void (async () => {
        const manager = await extensionsManager(
          session,
          !!session.publicChildExtensionAgent,
        );
        try {
          if (command && session.publicChildExtensionAgent) {
            const binding = session.publicChildExtensionAgent;
            const source = parseManagedExtensionEffectiveBundle(
              JSON.parse(
                (
                  await session.managed.resources.read(
                    binding.effectiveConfigRef,
                  )
                ).toString('utf8'),
              ),
            );
            if (
              !isDeepStrictEqual(
                command,
                hostedChildExtensionApplyCommand(
                  session.managed.authority.sessionHeader.sessionKey.sessionId,
                  binding.effectiveConfigRef.digest,
                  source.packages.map((entry) => entry.pin),
                ),
              )
            )
              throw new HostedMcpConflictError(
                'Child extension configuration is immutable.',
              );
          }
          if (command) await manager.submit(command);
          else if (action === 'continue') await manager.continue(operationId);
          else await manager.recoverPrevious(operationId);
          session.extensionBootstrapPending =
            await extensionBootstrapIncomplete(session, manager);
          session.blocked =
            manager.pending || session.extensionBootstrapPending;
          res.status(202).json(await manager.snapshot(operationId));
        } catch (cause) {
          session.extensionBootstrapPending =
            await extensionBootstrapIncomplete(session, manager);
          session.blocked =
            manager.pending || session.extensionBootstrapPending;
          if (cause instanceof HostedExtensionRevisionConflict)
            error(res, 409, 'extension_config_revision_conflict');
          else if (
            cause instanceof HostedMcpConflictError ||
            cause instanceof ManagedSessionConflictError ||
            cause instanceof ManagedSessionCommitRejectedError
          )
            error(res, 409, 'hosted_extension_configuration_conflict');
          else if (manager.enabled)
            res.status(202).json(await manager.snapshot(operationId));
          else error(res, 503, 'hosted_extension_recovery_required');
        }
      })()
        .catch(() => {
          if (!res.headersSent)
            error(res, 503, 'hosted_extension_recovery_required');
        })
        .finally(() => {
          session.mcpBusy = false;
        });
    });
  }

  app.get('/session/:id/mcp/management', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (session.recoveryCleanupOnly)
      return error(res, 409, 'hosted_mcp_session_load_required');
    void (async () => {
      if (session.extensions?.enabled) {
        res.json(await session.extensions.mcpSnapshot());
        return;
      }
      const manager = mcpManager(session);
      await manager.open();
      res.json(await manager.snapshot());
    })().catch(() => error(res, 409, 'hosted_mcp_management_unavailable'));
  });

  app.get('/session/:id/mcp/management/operations/:operationId', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (session.recoveryCleanupOnly)
      return error(res, 409, 'hosted_mcp_session_load_required');
    void (async () => {
      if (session.extensions?.enabled) {
        res.json(
          await session.extensions.mcpSnapshot(
            req.params['operationId'],
            false,
          ),
        );
        return;
      }
      const manager = mcpManager(session);
      await manager.open();
      if (!manager.status(req.params['operationId']))
        return error(res, 404, 'hosted_mcp_command_not_found');
      res.json(await manager.snapshot(false, req.params['operationId']));
    })().catch(() => error(res, 409, 'hosted_mcp_recovery_required'));
  });

  app.post('/session/:id/mcp/management', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (session.recoveryCleanupOnly)
      return error(res, 409, 'hosted_mcp_session_load_required');
    if (
      session.active ||
      session.hooksBusy ||
      session.mcpBusy ||
      session.mcpRecovering ||
      session.mcpClosing ||
      session.lifecycle ||
      session.blocked ||
      session.hooks?.mountWorkUnproven()
    )
      return error(res, 409, 'hosted_turn_active');
    let command;
    let manager: HostedMcpManager | undefined;
    try {
      command = parseHostedMcpCommand(req.body);
      if (!session.extensions?.enabled) manager = mcpManager(session);
    } catch {
      return error(res, 400, 'invalid_mcp_command');
    }
    session.mcpBusy = true;
    void (async () => {
      try {
        if (session.extensions?.enabled) {
          await session.extensions.submitMcp(command);
          res
            .status(202)
            .json(
              await session.extensions.mcpSnapshot(command.operationId, false),
            );
          return;
        }
        if (!manager) throw new Error('MCP manager is unavailable.');
        await manager.open();
        await manager.submit(command);
        res
          .status(202)
          .json(await manager.snapshot(false, command.operationId));
      } catch (cause) {
        if (
          cause instanceof HostedMcpConflictError ||
          cause instanceof ManagedSessionConflictError ||
          cause instanceof ManagedSessionCommitRejectedError
        )
          error(res, 409, 'hosted_mcp_configuration_conflict');
        else if (session.extensions?.enabled)
          res
            .status(202)
            .json(
              await session.extensions.mcpSnapshot(command.operationId, false),
            );
        else if (manager?.status(command.operationId))
          res
            .status(202)
            .json(await manager.snapshot(false, command.operationId));
        else error(res, 503, 'hosted_mcp_recovery_required');
      } finally {
        if (manager) session.mcp = manager.mcp;
        if (session.extensions?.enabled)
          session.blocked = session.extensions.pending;
        if (session.mcp && session.hooks?.broker === session.mcp.broker)
          session.hooks.delegateBrokerToMcp();
        session.mcpBusy = false;
      }
    })().catch(() => {
      session.mcpBusy = false;
      if (!res.headersSent) error(res, 503, 'hosted_mcp_recovery_required');
    });
  });

  app.get('/session/:id/mcp-catalog', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.mcp) return error(res, 409, 'hosted_mcp_unavailable');
    res.json({ catalogs: session.mcp.getCatalogs() });
  });

  app.post('/session/:id/mcp/configurations', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.mcp) return error(res, 409, 'hosted_mcp_unavailable');
    if (session.mcpBusy || session.mcpRecovering || session.blocked)
      return error(res, 409, 'hosted_mcp_operation_active');
    const body = object(req.body);
    const operationId = body?.['operationId'];
    const expectedRevision = body?.['expectedRevision'];
    let pin: HostedMcpServerPin;
    try {
      if (
        typeof operationId !== 'string' ||
        !HOSTED_UUID.test(operationId) ||
        !Number.isSafeInteger(expectedRevision) ||
        Number(expectedRevision) < 1
      )
        throw new Error('Invalid configuration command.');
      [pin] = parseHostedMcpServers([body?.['server']]);
    } catch {
      return error(res, 400, 'invalid_mcp_configuration');
    }
    session.mcpBusy = true;
    void session.mcp
      .configure(operationId as string, pin, Number(expectedRevision))
      .then(
        () => res.status(202).json({ operationId, state: 'settled' }),
        (cause: unknown) => {
          if (cause instanceof HostedMcpRecoveryRequiredError) {
            error(res, 503, 'hosted_mcp_recovery_required');
            return;
          }
          error(
            res,
            409,
            cause instanceof HostedMcpConnectionQuotaError
              ? cause.message
              : 'hosted_mcp_configuration_failed',
          );
        },
      )
      .finally(() => {
        session.mcpBusy = false;
      });
  });

  app.post('/session/:id/mcp/operations', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.mcp) return error(res, 409, 'hosted_mcp_unavailable');
    if (
      session.active ||
      session.mcpBusy ||
      session.mcpRecovering ||
      session.hooksBusy
    )
      return error(res, 409, 'hosted_turn_active');
    const body = object(req.body);
    const operationId = body?.['operationId'];
    const serverId = body?.['serverId'];
    const request = object(body?.['request']);
    if (
      typeof operationId !== 'string' ||
      !HOSTED_UUID.test(operationId) ||
      typeof serverId !== 'string' ||
      !request
    )
      return error(res, 400, 'invalid_mcp_operation');
    let invocation: Parameters<HostedMcpSession['invoke']>[2];
    if (
      request['kind'] === 'resource_read' &&
      Object.keys(request).sort().join(',') === 'kind,uri' &&
      typeof request['uri'] === 'string' &&
      request['uri'].trim().length > 0
    ) {
      invocation = { kind: 'resource_read', uri: request['uri'] };
    } else if (
      request['kind'] === 'prompt_get' &&
      Object.keys(request).sort().join(',') === 'arguments,kind,name' &&
      typeof request['name'] === 'string' &&
      request['name'].trim().length > 0 &&
      object(request['arguments']) &&
      Object.values(request['arguments'] as object).every(
        (value) => typeof value === 'string',
      )
    ) {
      invocation = {
        kind: 'prompt_get',
        name: request['name'],
        arguments: request['arguments'] as Record<string, string>,
      };
    } else return error(res, 400, 'invalid_mcp_operation');
    const strings =
      invocation.kind === 'resource_read'
        ? [invocation.uri]
        : [invocation.name, ...Object.entries(invocation.arguments).flat()];
    if (strings.some((value) => /\p{Cs}/u.test(value)))
      return error(res, 400, 'invalid_mcp_operation');
    if (
      (session.blocked || session.mcp.hasPendingOperations()) &&
      !session.managed.authority.extensionRecord('mcp_operation', operationId)
    )
      return error(
        res,
        409,
        'hosted_turn_recovery_required',
        hostedTurnBusyReason(session),
      );
    session.mcpBusy = true;
    void session.mcp
      .invoke(operationId, serverId, invocation)
      .then(
        (response) => {
          res.status(202).json(response);
        },
        (cause: unknown) => {
          error(
            res,
            cause instanceof HostedMcpConflictError ||
              cause instanceof HostedMcpConnectionQuotaError
              ? 409
              : 503,
            cause instanceof HostedMcpConnectionQuotaError
              ? cause.message
              : 'hosted_mcp_operation_failed',
          );
        },
      )
      .finally(() => {
        session.mcpBusy = false;
      });
  });

  app.post('/session/:id/mcp/operations/:operationId/cancel', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.mcp) return error(res, 409, 'hosted_mcp_unavailable');
    if (session.mcpClosing || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    session.mcpRecovering += 1;
    void session.mcp
      .cancel(req.params['operationId'])
      .then(
        (response) => res.status(202).json(response),
        () => error(res, 503, 'hosted_mcp_cancel_failed'),
      )
      .finally(() => {
        session.mcpRecovering -= 1;
      });
  });

  app.get('/session/:id/mcp/operations/:operationId', (req, res) => {
    const session = identity(req, sessions);
    if (!session) return error(res, 404, 'hosted_session_not_found');
    if (!session.mcp) return error(res, 409, 'hosted_mcp_unavailable');
    if (session.mcpClosing || session.mcpRecovering)
      return error(res, 409, 'hosted_mcp_operation_active');
    session.mcpRecovering += 1;
    void session.mcp
      .status(req.params['operationId'])
      .then(
        (response) => res.json(response),
        () => error(res, 503, 'hosted_mcp_status_failed'),
      )
      .finally(() => {
        session.mcpRecovering -= 1;
      });
  });
}
