import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setupConfigDir() {
  const configDir = join(tmpdir(), `qwen-default-conversation-${crypto.randomUUID()}`)
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, 'config-defaults.json'),
    JSON.stringify({
      version: 'test',
      description: 'test defaults',
      defaults: {
        notificationsEnabled: true,
        colorTheme: 'default',
        autoCapitalisation: true,
        sendMessageKey: 'enter',
        spellCheck: false,
        keepAwakeWhileRunning: false,
        richToolDescriptions: true,
      },
      workspaceDefaults: {
        permissionMode: 'safe',
        cyclablePermissionModes: ['safe', 'allow-all'],
        localMcpServers: { enabled: true },
      },
    }, null, 2),
    'utf-8',
  )
  return configDir
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function runEval(configDir: string, defaultWorkspaceDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { ensureDefaultConversationWorkspace, getWorkspaces, removeWorkspace, reorderWorkspaces } from '${STORAGE_MODULE_PATH}'; ${code}`,
  ], {
    env: {
      ...process.env,
      CRAFT_CONFIG_DIR: configDir,
      QWEN_DEFAULT_WORKSPACE_DIR: defaultWorkspaceDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (run.exitCode !== 0) {
    throw new Error(`subprocess failed (exit ${run.exitCode})\nstdout:\n${run.stdout.toString()}\nstderr:\n${run.stderr.toString()}`)
  }

  return run.stdout.toString().trim()
}

describe('default conversation workspace', () => {
  it('creates a protected Qwen conversation workspace outside managed project storage', () => {
    const configDir = setupConfigDir()
    const defaultWorkspaceDir = join(tmpdir(), `qwen-documents-${crypto.randomUUID()}`, 'Qwen')

    const output = runEval(
      configDir,
      defaultWorkspaceDir,
      `const ws = ensureDefaultConversationWorkspace(); console.log(JSON.stringify({ ws, all: getWorkspaces() }));`,
    )
    const { ws, all } = JSON.parse(output)

    expect(ws.rootPath).toBe(defaultWorkspaceDir)
    expect(ws.kind).toBe('conversation')
    expect(ws.isProtected).toBe(true)
    expect(all).toHaveLength(1)

    const rootConfig = readJson(join(configDir, 'config.json'))
    expect(rootConfig.activeWorkspaceId).toBe(ws.id)
    expect(rootConfig.workspaces[0].rootPath).toBe(defaultWorkspaceDir)

    const workspaceConfig = readJson(join(defaultWorkspaceDir, 'config.json'))
    expect(workspaceConfig.name).toBe('Qwen')
    expect(workspaceConfig.kind).toBe('conversation')
    expect(workspaceConfig.isProtected).toBe(true)
    expect(workspaceConfig.defaults.workingDirectory).toBe(defaultWorkspaceDir)
    expect(existsSync(join(configDir, 'workspaces', 'my-workspace'))).toBe(false)
  })

  it('does not remove or reorder protected conversation workspaces', () => {
    const configDir = setupConfigDir()
    const defaultWorkspaceDir = join(tmpdir(), `qwen-documents-${crypto.randomUUID()}`, 'Qwen')

    const output = runEval(
      configDir,
      defaultWorkspaceDir,
      `const ws = ensureDefaultConversationWorkspace(); const removed = await removeWorkspace(ws.id); const reordered = reorderWorkspaces([ws.id]); console.log(JSON.stringify({ removed, reordered, all: getWorkspaces() }));`,
    )
    const result = JSON.parse(output)

    expect(result.removed).toBe(false)
    expect(result.reordered).toBe(true)
    expect(result.all).toHaveLength(1)
    expect(result.all[0].kind).toBe('conversation')
  })
})
