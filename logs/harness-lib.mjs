import { _electron as electron } from 'playwright'
import fs from 'fs'
import path from 'path'

export const DESKTOP = process.env.DESKTOP_DIR
export const OUT = process.env.OUT_DIR
export const LABEL = process.env.LABEL || 'run'

export function setupEnvDirs(label = LABEL) {
  const base = path.join(OUT, `env-${label}`)
  const configDir = path.join(base, 'craft-config')
  const userData = path.join(base, 'userdata')
  const workspace = path.join(base, 'workspace')
  fs.rmSync(base, { recursive: true, force: true })
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(path.join(workspace, 'sessions'), { recursive: true })

  const wsId = '11111111-2222-3333-4444-555555555555'
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify(
      {
        workspaces: [
          {
            id: wsId,
            name: 'Verify',
            slug: 'Verify',
            rootPath: workspace,
            kind: 'conversation',
            isProtected: false,
            createdAt: 1786444037478,
          },
        ],
        activeWorkspaceId: wsId,
        activeSessionId: null,
        llmConnections: [
          { slug: 'qwen-code', name: 'Qwen Code', providerType: 'qwen', authType: 'none', createdAt: 1786444037456 },
        ],
        defaultLlmConnection: 'qwen-code',
        language: 'en',
      },
      null,
      2,
    ),
  )
  return { base, configDir, userData, workspace, wsId }
}

export async function launch({ configDir, userData, workspace }) {
  const executablePath = path.join(DESKTOP, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  const app = await electron.launch({
    executablePath,
    args: [path.join(DESKTOP, 'apps/electron'), '--lang=en-US'],
    cwd: DESKTOP,
    env: {
      ...process.env,
      LANG: 'en_US.UTF-8',
      CRAFT_CONFIG_DIR: configDir,
      CRAFT_USER_DATA_DIR: userData,
      CRAFT_WORKSPACE_DIR: workspace,
    },
    timeout: 120000,
  })
  const win = await app.firstWindow({ timeout: 120000 })
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}
