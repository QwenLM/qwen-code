import { describe, expect, it } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setupConfigDir() {
  const configDir = join(tmpdir(), `craft-workspace-reorder-${crypto.randomUUID()}`)
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
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      workspaces: [
        { id: 'ws-a', name: 'A', slug: 'a', rootPath: join(configDir, 'a'), createdAt: 1 },
        { id: 'ws-b', name: 'B', slug: 'b', rootPath: join(configDir, 'b'), createdAt: 2 },
        { id: 'ws-c', name: 'C', slug: 'c', rootPath: join(configDir, 'c'), createdAt: 3 },
      ],
      activeWorkspaceId: 'ws-a',
      activeSessionId: null,
    }, null, 2),
    'utf-8',
  )
  return configDir
}

function readWorkspaceIds(configDir: string): string[] {
  const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8'))
  return config.workspaces.map((workspace: { id: string }) => workspace.id)
}

function runEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { reorderWorkspaces } from '${STORAGE_MODULE_PATH}'; ${code}`,
  ], {
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (run.exitCode !== 0) {
    throw new Error(`subprocess failed (exit ${run.exitCode})\nstdout:\n${run.stdout.toString()}\nstderr:\n${run.stderr.toString()}`)
  }

  return run.stdout.toString().trim()
}

describe('reorderWorkspaces', () => {
  it('persists the requested workspace order', () => {
    const configDir = setupConfigDir()

    const output = runEval(configDir, "console.log(String(reorderWorkspaces(['ws-c', 'ws-a', 'ws-b'])))")

    expect(output).toBe('true')
    expect(readWorkspaceIds(configDir)).toEqual(['ws-c', 'ws-a', 'ws-b'])
  })

  it('ignores unknown and duplicate ids, then appends omitted workspaces', () => {
    const configDir = setupConfigDir()

    const output = runEval(configDir, "console.log(String(reorderWorkspaces(['ws-c', 'missing', 'ws-c'])))")

    expect(output).toBe('true')
    expect(readWorkspaceIds(configDir)).toEqual(['ws-c', 'ws-a', 'ws-b'])
  })

  it('does not save when no requested ids match existing workspaces', () => {
    const configDir = setupConfigDir()

    const output = runEval(configDir, "console.log(String(reorderWorkspaces(['missing'])))")

    expect(output).toBe('false')
    expect(readWorkspaceIds(configDir)).toEqual(['ws-a', 'ws-b', 'ws-c'])
  })
})
