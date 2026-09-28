/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { ExtensionStore } from '@qwen-code/qwen-code-core/extension/extension-store.js';
import {
  evaluateManagedCompatibility,
  type ManagedCompatibilityRuntime,
} from './managed-compatibility.js';

describe('evaluateManagedCompatibility', () => {
  let root: string;
  let workspace: string;
  let qwenHome: string;
  let requestCwd: string;
  let runtime: ManagedCompatibilityRuntime & {
    workspaceCwd: string;
    workspaceTrusted: boolean;
    forwardedArgs: string[];
    liveMcpServers: boolean;
  };

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-compat-')),
    );
    workspace = path.join(root, 'workspace');
    qwenHome = path.join(root, 'qwen-home');
    fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    fs.mkdirSync(qwenHome, { recursive: true });
    fs.mkdirSync(path.join(root, 'system'), { recursive: true });
    requestCwd = workspace;
    runtime = {
      workspaceCwd: workspace,
      workspaceTrusted: true,
      environment: {
        QWEN_HOME: qwenHome,
        QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(
          root,
          'system',
          'settings.json',
        ),
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(
          root,
          'system',
          'system-defaults.json',
        ),
      },
      forwardedArgs: [],
      liveMcpServers: false,
      hasLiveMcpServers() {
        return this.liveMcpServers;
      },
    };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeJson = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const userSettings = () => path.join(qwenHome, 'settings.json');
  const workspaceSettings = () =>
    path.join(workspace, '.qwen', 'settings.json');
  const systemSettings = () => path.join(root, 'system', 'settings.json');
  const systemDefaults = () =>
    path.join(root, 'system', 'system-defaults.json');
  const store = () =>
    new ExtensionStore({
      extensionsDir: path.join(qwenHome, 'extensions'),
      storeDir: path.join(qwenHome, 'extension-store'),
    });

  // Every entry under the root with its bytes and identity.
  const describeTree = (): string[] => {
    const lines: string[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory).sort()) {
        const entryPath = path.join(directory, entry);
        const stats = fs.lstatSync(entryPath, { bigint: true });
        const identity = `${stats.ino}:${stats.mtimeNs}:${stats.ctimeNs}`;
        if (stats.isDirectory()) {
          lines.push(`${path.relative(root, entryPath)}/ ${identity}`);
          walk(entryPath);
        } else {
          lines.push(
            `${path.relative(root, entryPath)} ${identity} ${
              stats.isFile() ? fs.readFileSync(entryPath, 'utf8') : 'link'
            }`,
          );
        }
      }
    };
    walk(root);
    return lines;
  };

  // Every evaluation must leave the tree and the process environment exactly
  // as it found them, whatever it answers.
  const evaluate = async (approvalMode?: ApprovalMode) => {
    const treeBefore = describeTree();
    const environmentBefore = { ...process.env };
    const result = await evaluateManagedCompatibility(
      { workspaceCwd: requestCwd, ...(approvalMode ? { approvalMode } : {}) },
      runtime,
    );
    expect(describeTree()).toEqual(treeBefore);
    expect(process.env).toEqual(environmentBefore);
    return result;
  };

  it('accepts an empty trusted workspace', async () => {
    await expect(evaluate()).resolves.toEqual({ status: 'compatible' });
  });

  it('accepts ordinary configuration', async () => {
    writeJson(userSettings(), {
      $version: 3,
      ui: { theme: 'Default' },
      hooks: { enabled: true, disabled: ['retired-hook'] },
    });
    writeJson(workspaceSettings(), { hooks: { PreToolUse: [] } });
    await store().ensureInitialized([]);
    await store().readSnapshot();

    await expect(evaluate(ApprovalMode.YOLO)).resolves.toEqual({
      status: 'compatible',
    });
  });

  it.each<[string, () => void | Promise<void>, string]>([
    [
      'an untrusted workspace',
      () => {
        runtime.workspaceTrusted = false;
      },
      'the workspace is not trusted',
    ],
    [
      'forwarded LSP',
      () => {
        runtime.forwardedArgs = ['--experimental-lsp'];
      },
      'the daemon enables LSP for its sessions',
    ],
    [
      'restored user questions',
      () => {
        runtime.forwardedArgs = ['--restore-ask-user-question'];
      },
      'the daemon restores unanswered user questions',
    ],
    [
      'a known argument forwarded after an unknown one',
      () => {
        runtime.forwardedArgs = [
          '--managed-extensions',
          '/opt/extensions',
          '--restore-ask-user-question',
        ];
      },
      'the daemon restores unanswered user questions',
    ],
    [
      'live MCP servers',
      () => {
        runtime.liveMcpServers = true;
      },
      'MCP servers were added to the running workspace',
    ],
    [
      'user MCP servers',
      () =>
        writeJson(userSettings(), {
          mcpServers: { demo: { command: 'demo' } },
        }),
      'MCP servers are configured in settings',
    ],
    [
      'workspace MCP servers',
      () =>
        writeJson(workspaceSettings(), {
          mcpServers: { demo: { command: 'demo' } },
        }),
      'MCP servers are configured in settings',
    ],
    [
      'system MCP servers',
      () =>
        writeJson(systemSettings(), {
          mcpServers: { demo: { command: 'demo' } },
        }),
      'MCP servers are configured in settings',
    ],
    [
      'system default MCP servers',
      () =>
        writeJson(systemDefaults(), {
          mcpServers: { demo: { command: 'demo' } },
        }),
      'MCP servers are configured in settings',
    ],
    [
      'an MCP server command',
      () => writeJson(userSettings(), { mcp: { serverCommand: 'demo' } }),
      'an MCP server command is configured',
    ],
    [
      'a tool discovery command',
      () =>
        writeJson(workspaceSettings(), { tools: { discoveryCommand: 'demo' } }),
      'a tool discovery or call command is configured',
    ],
    [
      'a tool call command',
      () => writeJson(userSettings(), { tools: { callCommand: 'demo' } }),
      'a tool discovery or call command is configured',
    ],
    [
      'user hooks',
      () =>
        writeJson(userSettings(), {
          hooks: { PreToolUse: [{ hooks: [{ type: 'command' }] }] },
        }),
      'hooks are configured in settings',
    ],
    [
      'project hooks',
      () =>
        writeJson(workspaceSettings(), {
          hooks: { Stop: [{ hooks: [{ type: 'command' }] }] },
        }),
      'hooks are configured in settings',
    ],
    [
      'system hooks',
      () =>
        writeJson(systemSettings(), {
          hooks: { SessionStart: [{ hooks: [{ type: 'command' }] }] },
        }),
      'hooks are configured in settings',
    ],
    [
      'a hooks entry that is not a list',
      () => writeJson(userSettings(), { hooks: { PreToolUse: {} } }),
      'hooks are configured in settings',
    ],
    [
      'plan mode from settings',
      () => writeJson(userSettings(), { tools: { approvalMode: 'plan' } }),
      'plan mode needs tools the engine does not provide',
    ],
    [
      'plan mode spelled another way in settings',
      () =>
        writeJson(workspaceSettings(), { tools: { approvalMode: ' Plan ' } }),
      'plan mode needs tools the engine does not provide',
    ],
    [
      'project MCP servers',
      () =>
        writeJson(path.join(workspace, '.mcp.json'), {
          mcpServers: { demo: { command: 'demo' } },
        }),
      'MCP servers are configured in the project MCP file',
    ],
    [
      'an installed extension',
      () =>
        fs.mkdirSync(path.join(qwenHome, 'extensions', 'demo'), {
          recursive: true,
        }),
      'extensions are installed',
    ],
  ])('defers %s', async (_name, arrange, reason) => {
    await arrange();

    await expect(evaluate()).resolves.toEqual({ status: 'deferred', reason });
  });

  it('defers plan mode requested by the session', async () => {
    await expect(evaluate(ApprovalMode.PLAN)).resolves.toEqual({
      status: 'deferred',
      reason: 'plan mode needs tools the engine does not provide',
    });
  });

  it('lets a requested approval mode replace plan mode from settings', async () => {
    writeJson(userSettings(), { tools: { approvalMode: 'plan' } });

    await expect(evaluate(ApprovalMode.DEFAULT)).resolves.toEqual({
      status: 'compatible',
    });
  });

  it('defers a session outside the runtime workspace', async () => {
    fs.mkdirSync(path.join(root, 'other'));
    requestCwd = path.join(root, 'other');

    await expect(evaluate()).resolves.toEqual({
      status: 'deferred',
      reason: 'the session directory is not the runtime workspace',
    });
  });

  it.each<[string, () => void | Promise<void>, string]>([
    [
      'a session directory that cannot be resolved',
      () => {
        requestCwd = path.join(root, 'missing');
      },
      'the session or workspace directory could not be resolved',
    ],
    [
      'a workspace that cannot be resolved',
      () => {
        runtime = { ...runtime, workspaceCwd: path.join(root, 'missing') };
      },
      'the session or workspace directory could not be resolved',
    ],
    [
      'a forwarded argument the evaluation does not know',
      () => {
        runtime.forwardedArgs = ['--managed-extensions', '/opt/extensions'];
      },
      'the daemon forwards an argument the evaluation does not know',
    ],
    [
      'a runtime without an environment',
      () => {
        runtime = {
          ...runtime,
          environment: undefined as unknown as NodeJS.ProcessEnv,
        };
      },
      'the settings could not be read',
    ],
    [
      'unreadable settings',
      () => fs.writeFileSync(workspaceSettings(), '{ "ui": '),
      'the settings could not be read',
    ],
    [
      'an approval mode in settings that session creation rejects',
      () => writeJson(userSettings(), { tools: { approvalMode: 'bogus' } }),
      'the approval mode in settings is not valid',
    ],
    [
      'an unreadable project MCP file',
      () => fs.mkdirSync(path.join(workspace, '.mcp.json')),
      'the project MCP file could not be read or is malformed',
    ],
    [
      'a project MCP file that does not parse',
      () => fs.writeFileSync(path.join(workspace, '.mcp.json'), '{'),
      'the project MCP file could not be read or is malformed',
    ],
    [
      'a project MCP file without a servers object',
      () => writeJson(path.join(workspace, '.mcp.json'), {}),
      'the project MCP file could not be read or is malformed',
    ],
    [
      'a locked extension store',
      async () => {
        await store().ensureInitialized([]);
        fs.mkdirSync(path.join(qwenHome, 'extension-store', 'lock.lock'));
      },
      'the extension store is locked',
    ],
  ])('reports %s as unknown', async (_name, arrange, reason) => {
    await arrange();

    await expect(evaluate()).resolves.toEqual({ status: 'unknown', reason });
  });

  it('reports an invalid approval mode in settings even when the session requests one', async () => {
    writeJson(userSettings(), { tools: { approvalMode: 'bogus' } });

    await expect(evaluate(ApprovalMode.DEFAULT)).resolves.toEqual({
      status: 'unknown',
      reason: 'the approval mode in settings is not valid',
    });
  });
});
