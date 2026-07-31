import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setupConfigDir() {
  const configDir = join(tmpdir(), `craft-project-workspace-${crypto.randomUUID()}`)
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

function setupProjectDir(name = 'qwen-code') {
  const projectDir = join(tmpdir(), `${name}-${crypto.randomUUID()}`)
  mkdirSync(join(projectDir, '.git'), { recursive: true })
  writeFileSync(join(projectDir, 'package.json'), '{"name":"project"}\n', 'utf-8')
  return projectDir
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function runEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { addWorkspace, loadStoredConfig } from '${STORAGE_MODULE_PATH}'; ${code}`,
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

describe('project-root workspace storage', () => {
  it('stores new workspaces for existing projects under managed config storage', () => {
    const configDir = setupConfigDir()
    const projectDir = setupProjectDir()

    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ workspaces: [], activeWorkspaceId: null, activeSessionId: null }, null, 2),
      'utf-8',
    )

    const output = runEval(
      configDir,
      `const ws = addWorkspace({ name: 'qwen-code', rootPath: ${JSON.stringify(projectDir)} }); console.log(JSON.stringify(ws));`,
    )
    const workspace = JSON.parse(output)

    expect(workspace.rootPath).toStartWith(join(configDir, 'workspaces'))
    expect(existsSync(join(projectDir, 'config.json'))).toBe(false)
    expect(existsSync(join(projectDir, '.agents-plugin', 'plugin.json'))).toBe(false)
    expect(existsSync(join(workspace.rootPath, 'skills'))).toBe(false)

    const workspaceConfig = readJson(join(workspace.rootPath, 'config.json'))
    expect(workspaceConfig.defaults.workingDirectory).toBe(projectDir)
  })

  it('stores newly-created external project folders under managed config storage', () => {
    const configDir = setupConfigDir()
    const parentDir = join(tmpdir(), `craft-new-project-parent-${crypto.randomUUID()}`)
    const projectDir = join(parentDir, 'fresh-project')
    mkdirSync(parentDir, { recursive: true })

    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ workspaces: [], activeWorkspaceId: null, activeSessionId: null }, null, 2),
      'utf-8',
    )

    const output = runEval(
      configDir,
      `const ws = addWorkspace({ name: 'fresh-project', rootPath: ${JSON.stringify(projectDir)} }); console.log(JSON.stringify(ws));`,
    )
    const workspace = JSON.parse(output)

    expect(existsSync(projectDir)).toBe(true)
    expect(workspace.rootPath).toStartWith(join(configDir, 'workspaces'))
    expect(existsSync(join(projectDir, 'config.json'))).toBe(false)
    expect(existsSync(join(projectDir, 'sessions'))).toBe(false)
    expect(existsSync(join(projectDir, 'sources'))).toBe(false)
    expect(existsSync(join(projectDir, 'skills'))).toBe(false)
    expect(existsSync(join(projectDir, '.agents-plugin', 'plugin.json'))).toBe(false)

    const workspaceConfig = readJson(join(workspace.rootPath, 'config.json'))
    expect(workspaceConfig.defaults.workingDirectory).toBe(projectDir)
  })

  it('migrates legacy external project workspaces without writing more project files', () => {
    const configDir = setupConfigDir()
    const projectDir = setupProjectDir()

    writeFileSync(
      join(projectDir, 'config.json'),
      JSON.stringify({
        id: 'ws_legacy',
        name: 'qwen-code',
        slug: 'qwen-code',
        defaults: { permissionMode: 'safe' },
        createdAt: 1,
        updatedAt: 1,
      }, null, 2),
      'utf-8',
    )
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        workspaces: [{ id: 'ws-1', name: 'qwen-code', slug: 'qwen-code', rootPath: projectDir, createdAt: 1 }],
        activeWorkspaceId: 'ws-1',
        activeSessionId: null,
      }, null, 2),
      'utf-8',
    )

    runEval(configDir, 'loadStoredConfig();')

    const config = readJson(join(configDir, 'config.json'))
    const workspace = config.workspaces[0]
    expect(workspace.rootPath).toBe(join(configDir, 'workspaces', 'qwen-code'))
    expect(existsSync(join(projectDir, '.agents-plugin', 'plugin.json'))).toBe(false)

    const managedRoot = join(configDir, 'workspaces', 'qwen-code')
    expect(existsSync(join(managedRoot, 'skills'))).toBe(false)
    const workspaceConfig = readJson(join(managedRoot, 'config.json'))
    expect(workspaceConfig.defaults.workingDirectory).toBe(projectDir)
  })
})
