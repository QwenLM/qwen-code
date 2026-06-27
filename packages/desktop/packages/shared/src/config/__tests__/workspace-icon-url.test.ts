import { describe, expect, it } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setupConfigDir(iconUrl: string) {
  const configDir = join(tmpdir(), `qwen-workspace-icon-${crypto.randomUUID()}`)
  const workspaceRoot = join(configDir, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  writeFileSync(join(workspaceRoot, 'icon.svg'), '<svg />', 'utf-8')
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
    }),
    'utf-8',
  )
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      workspaces: [
        {
          id: 'ws-a',
          name: 'A',
          slug: 'a',
          rootPath: workspaceRoot,
          iconUrl,
          createdAt: 1,
        },
      ],
      activeWorkspaceId: 'ws-a',
      activeSessionId: null,
    }),
    'utf-8',
  )
  return configDir
}

function readWorkspaceIconUrl(configDir: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { getWorkspaces } from '${STORAGE_MODULE_PATH}'; console.log(getWorkspaces()[0].iconUrl);`,
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

describe('workspace icon URLs', () => {
  it('preserves uppercase remote icon URL schemes instead of falling back to local icons', () => {
    const iconUrl = 'HTTPS://cdn.example.com/workspace.svg'
    const configDir = setupConfigDir(iconUrl)

    expect(readWorkspaceIconUrl(configDir)).toBe(iconUrl)
  })
})
