/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { getCurrentLanguage, setLanguageAsync } from '../../i18n/index.js';
import {
  resolveOutputLanguageOrPreserveAuto,
  updateOutputLanguageFile,
} from '../../i18n/languageUtils.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { SessionNotFoundError } from '../acp-session-bridge.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import {
  resolveTrustedRuntime,
  sendGenerationClosedError,
} from '../workspace-route-runtime.js';
import { parseAndValidateWorkspaceClientId } from '../server/request-helpers.js';

export interface UserLanguageRouteDeps {
  /**
   * Primary workspace cwd. User-scope persistence is workspace-independent;
   * the value is only the `persistSetting` settings-lock key, matching how
   * the primary `/workspace/settings` route locks user-scope writes.
   */
  boundWorkspace: string;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  languageCodes: readonly string[];
  persistSetting: (
    workspace: string,
    scope: SettingScope,
    key: string,
    value: unknown,
    assertGenerationOpen?: () => void,
  ) => Promise<unknown>;
  workspaceRegistry: WorkspaceRegistry;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
  ) => string | undefined | null;
}

/**
 * `POST /language` — sessionless user-level language sync (upstream issue
 * #10234) for hosts that need to switch language before any session exists.
 *
 * Ownership classification: process-global. The route mutates user-global
 * state (`~/.qwen/settings.json`, the global `output-language.md`, every
 * runtime's process i18n and sessions), so it takes neither a workspace
 * selector nor a session id.
 *
 * Differences from the session-scoped `POST /session/:id/language`:
 * - project-bound output-language files are NOT rewritten — a session with
 *   its own registered path keeps its project override;
 * - zero sessions / zero live runtime channels is a success, not an error.
 */
export function registerUserLanguageRoutes(
  app: Application,
  deps: UserLanguageRouteDeps,
): void {
  // Selected-runtime scoped; cold runtimes read the persisted locale at startup.
  app.post(
    '/workspaces/:workspace/language',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
      if (!runtime) return;
      const body = deps.safeBody(req);
      const language = body['language'];
      if (
        typeof language !== 'string' ||
        !deps.languageCodes.includes(language)
      ) {
        res.status(400).json({
          error:
            '`language` is required and must be one of: ' +
            deps.languageCodes.join(', '),
          code: 'invalid_language',
          allowed: deps.languageCodes,
        });
        return;
      }
      if (
        body['syncOutputLanguage'] !== undefined &&
        body['syncOutputLanguage'] !== false
      ) {
        res.status(400).json({
          error:
            '`syncOutputLanguage` must be false when provided on this route',
          code: 'invalid_sync_flag',
        });
        return;
      }
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;
      const assertGenerationOpen = () => runtime.generationGuard?.assertOpen();
      try {
        assertGenerationOpen();
        await deps.persistSetting(
          runtime.workspaceCwd,
          SettingScope.Workspace,
          'general.language',
          language,
          assertGenerationOpen,
        );
        assertGenerationOpen();
        let effective: string;
        try {
          const configuredLanguage = loadSettings(runtime.workspaceCwd, {
            skipLoadEnvironment: true,
            workspaceTrusted: true,
          }).merged.general?.language;
          effective =
            typeof configuredLanguage === 'string'
              ? configuredLanguage
              : language;
        } catch (error) {
          assertGenerationOpen();
          writeStderrLine(
            `qwen serve: workspace language saved but settings reload failed for ${runtime.workspaceCwd}: ${String(error)}`,
          );
          res.status(200).json({
            language,
            outputLanguage: null,
            refresh: { runtimes: 0, sessions: 0, failed: 1 },
          });
          return;
        }
        let failed = 0;
        let refreshedRuntimes = 0;
        let sessions = 0;
        try {
          const result = await runtime.bridge.setUserLanguage({
            language: effective,
            syncOutputLanguage: false,
            scope: 'workspace',
          });
          refreshedRuntimes = 1;
          sessions = result.sessions;
          failed = result.failed;
        } catch (error) {
          if (!(error instanceof SessionNotFoundError)) {
            failed = 1;
            writeStderrLine(
              `qwen serve: workspace language sync failed: ${String(error)}`,
            );
          }
        }
        assertGenerationOpen();
        try {
          runtime.bridge.publishWorkspaceEvent({
            type: 'language_changed',
            data: { language: effective, outputLanguage: null },
            ...(clientId ? { originatorClientId: clientId } : {}),
          });
        } catch (error) {
          writeStderrLine(
            `qwen serve: workspace language event publish failed: ${String(error)}`,
          );
        }
        res.status(200).json({
          language: effective,
          outputLanguage: null,
          refresh: { runtimes: refreshedRuntimes, sessions, failed },
        });
      } catch (error) {
        if (sendGenerationClosedError(res, error)) return;
        writeStderrLine(
          `qwen serve: workspace language persist error for ${runtime.workspaceCwd}: ${String(error)}`,
        );
        res.status(500).json({
          code: 'persist_error',
          error: 'Failed to change workspace UI language',
        });
      }
    },
  );
  app.post('/language', deps.mutate(), async (req, res) => {
    const body = deps.safeBody(req);
    const language = body['language'];
    const syncOutputLanguage = body['syncOutputLanguage'];

    if (
      typeof language !== 'string' ||
      !deps.languageCodes.includes(language)
    ) {
      res.status(400).json({
        error:
          '`language` is required and must be one of: ' +
          deps.languageCodes.join(', '),
        code: 'invalid_language',
        allowed: deps.languageCodes,
      });
      return;
    }
    if (
      syncOutputLanguage !== undefined &&
      typeof syncOutputLanguage !== 'boolean'
    ) {
      res.status(400).json({
        error: '`syncOutputLanguage` must be a boolean when provided',
        code: 'invalid_sync_flag',
      });
      return;
    }
    const clientId = deps.parseAndValidateClientId(req, res);
    if (clientId === null) return;

    // Persist in the daemon process — the single writer for user-scope
    // state, so the runtime fan-out below cannot race sibling runtimes on
    // the shared settings file. Each step fails before later side effects.
    let outputLanguage: string | null = null;
    try {
      await deps.persistSetting(
        deps.boundWorkspace,
        SettingScope.User,
        'general.language',
        language,
      );
      if (syncOutputLanguage === true) {
        const settingValue = resolveOutputLanguageOrPreserveAuto(language);
        updateOutputLanguageFile(settingValue);
        await deps.persistSetting(
          deps.boundWorkspace,
          SettingScope.User,
          'general.outputLanguage',
          settingValue,
        );
        outputLanguage = settingValue;
      }
    } catch (err) {
      writeStderrLine(
        `qwen serve: POST /language persist error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to persist language settings',
        code: 'persist_error',
      });
      return;
    }

    // The daemon's own i18n drives server-generated strings; runtimes
    // switch theirs during the fan-out. Best-effort either way.
    try {
      await setLanguageAsync(language);
    } catch (err) {
      writeStderrLine(
        `qwen serve: POST /language daemon i18n switch failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const resolvedLanguage = getCurrentLanguage();

    // Refresh trusted runtimes. A runtime without a live ACP channel is
    // skipped rather than failed: it has no sessions to refresh and reads
    // the persisted files when its channel next spawns.
    const sync = syncOutputLanguage === true;
    const runtimes = deps.workspaceRegistry.list().filter((r) => r.trusted);
    const results = await Promise.allSettled(
      runtimes.map((runtime) =>
        runtime.bridge.setUserLanguage({
          language,
          syncOutputLanguage: sync,
        }),
      ),
    );
    let refreshedRuntimes = 0;
    let sessions = 0;
    let failed = 0;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        refreshedRuntimes += 1;
        sessions += result.value.sessions;
        failed += result.value.failed;
        return;
      }
      if (result.reason instanceof SessionNotFoundError) return;
      failed += 1;
      writeStderrLine(
        `qwen serve: POST /language fan-out failed for workspace ${runtimes[index]?.workspaceCwd}: ${
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        }`,
      );
    });

    for (const runtime of deps.workspaceRegistry.list()) {
      try {
        runtime.bridge.publishWorkspaceEvent({
          type: 'language_changed',
          data: { language: resolvedLanguage, outputLanguage, userLevel: true },
          ...(clientId ? { originatorClientId: clientId } : {}),
        });
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /language event publish failed for workspace ${runtime.workspaceCwd}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    res.status(200).json({
      language: resolvedLanguage,
      outputLanguage,
      refresh: { runtimes: refreshedRuntimes, sessions, failed },
    });
  });
}
