import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const PI_RESOLVER_SETUP_PATH = pathToFileURL(join(import.meta.dir, '..', '..', '..', 'tests', 'setup', 'register-pi-model-resolver.ts')).href

function setupWorkspaceConfigDir() {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-config-'))
  const workspaceRoot = join(configDir, 'workspaces', 'my-workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  writeFileSync(
    join(workspaceRoot, 'config.json'),
    JSON.stringify(
      {
        id: 'ws-config-1',
        name: 'My Workspace',
        slug: 'my-workspace',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        defaults: {
          defaultLlmConnection: 'pi-api-key',
        },
      },
      null,
      2,
    ),
    'utf-8',
  )

  return { configDir, workspaceRoot, configPath: join(configDir, 'config.json') }
}

function writeRootConfig(configPath: string, workspaceRoot: string, extraConfig: Record<string, unknown>) {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        workspaces: [
          {
            id: 'ws-1',
            name: 'My Workspace',
            rootPath: workspaceRoot,
            createdAt: Date.now(),
          },
        ],
        activeWorkspaceId: 'ws-1',
        activeSessionId: null,
        ...extraConfig,
      },
      null,
      2,
    ),
    'utf-8',
  )
}

function runMigration(configDir: string) {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import '${PI_RESOLVER_SETUP_PATH}'; import { migrateLegacyLlmConnectionsConfig } from '${STORAGE_MODULE_PATH}'; migrateLegacyLlmConnectionsConfig();`,
  ], {
    env: {
      ...process.env,
      CRAFT_CONFIG_DIR: configDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (run.exitCode !== 0) {
    throw new Error(
      `migration subprocess failed (exit ${run.exitCode})\nstdout:\n${run.stdout.toString()}\nstderr:\n${run.stderr.toString()}`,
    )
  }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

describe('startup migration (integration)', () => {
  it('keeps only qwen-code and makes it the default connection', () => {
    const { configDir, workspaceRoot, configPath } = setupWorkspaceConfigDir()

    writeRootConfig(configPath, workspaceRoot, {
      defaultLlmConnection: 'pi-api-key',
      llmConnections: [
        {
          slug: 'pi-api-key',
          name: 'Craft Agents Backend (OpenAI)',
          providerType: 'pi',
          authType: 'api_key',
          piAuthProvider: 'openai',
          createdAt: Date.now(),
          models: ['pi/gpt-5'],
          defaultModel: 'pi/gpt-5',
        },
        {
          slug: 'anthropic-api',
          name: 'Anthropic',
          providerType: 'anthropic',
          authType: 'api_key',
          createdAt: Date.now(),
          models: ['claude-opus-4-7'],
          defaultModel: 'claude-opus-4-7',
        },
      ],
    })

    runMigration(configDir)

    const config = readJson(configPath)
    expect(config.defaultLlmConnection).toBe('qwen-code')
    expect(config.llmConnections).toHaveLength(1)
    expect(config.llmConnections[0]).toMatchObject({
      slug: 'qwen-code',
      name: 'Qwen Code',
      providerType: 'qwen',
      authType: 'none',
    })
  })

  it('preserves existing qwen models and default model', () => {
    const { configDir, workspaceRoot, configPath } = setupWorkspaceConfigDir()
    const qwenModels = [
      { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', shortName: 'Qwen Plus', description: '', provider: 'qwen', contextWindow: 1_000_000 },
      { id: 'qwen3-coder-flash', name: 'Qwen3 Coder Flash', shortName: 'Qwen Flash', description: '', provider: 'qwen', contextWindow: 1_000_000 },
    ]

    writeRootConfig(configPath, workspaceRoot, {
      defaultLlmConnection: 'qwen-code',
      llmConnections: [
        {
          slug: 'qwen-code',
          name: 'Qwen Code',
          providerType: 'qwen',
          authType: 'none',
          createdAt: Date.now(),
          models: qwenModels,
          defaultModel: 'qwen3-coder-flash',
        },
        {
          slug: 'pi-api-key',
          name: 'Craft Agents Backend',
          providerType: 'pi',
          authType: 'api_key',
          createdAt: Date.now(),
        },
      ],
    })

    runMigration(configDir)

    const [connection] = readJson(configPath).llmConnections
    expect(connection.slug).toBe('qwen-code')
    expect(connection.models).toEqual(qwenModels)
    expect(connection.defaultModel).toBe('qwen3-coder-flash')
  })

  it('creates qwen-code for configs without llmConnections and clears workspace connection overrides', () => {
    const { configDir, workspaceRoot, configPath } = setupWorkspaceConfigDir()

    writeRootConfig(configPath, workspaceRoot, {
      authType: 'api_key',
      model: 'claude-opus-4-7',
      defaultLlmConnection: 'anthropic-api',
    })

    runMigration(configDir)

    const config = readJson(configPath)
    expect(config.defaultLlmConnection).toBe('qwen-code')
    expect(config.llmConnections).toHaveLength(1)
    expect(config.llmConnections[0]).toMatchObject({
      slug: 'qwen-code',
      providerType: 'qwen',
      authType: 'none',
    })
    expect(config.authType).toBeUndefined()
    expect(config.model).toBeUndefined()

    const workspaceConfig = readJson(join(workspaceRoot, 'config.json'))
    expect(workspaceConfig.defaults.defaultLlmConnection).toBeUndefined()
  })
})
