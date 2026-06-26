import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(
  join(import.meta.dir, '..', 'storage.ts'),
).href

function runEval(configDir: string, code: string): void {
  const run = Bun.spawnSync(
    [
      process.execPath,
      '--eval',
      `import { setVoiceEnabled, setVoiceModel } from '${STORAGE_MODULE_PATH}'; ${code}`,
    ],
    {
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
      stderr: 'pipe',
    },
  )

  if (run.exitCode !== 0) {
    throw new Error(
      `subprocess failed (exit ${run.exitCode})\nstderr:\n${run.stderr.toString()}`,
    )
  }
}

describe('voice settings storage', () => {
  it('does not create a skeleton config when config.json does not exist yet', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-voice-settings-'))
    const configPath = join(configDir, 'config.json')

    runEval(
      configDir,
      "setVoiceModel('qwen3-asr-flash-realtime'); setVoiceEnabled(false);",
    )

    expect(existsSync(configPath)).toBe(false)
  })

  it('persists voice settings when config.json exists', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-voice-settings-'))
    const configPath = join(configDir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        workspaces: [],
        activeWorkspaceId: null,
        activeSessionId: null,
      }),
    )

    runEval(
      configDir,
      "setVoiceModel('qwen3-asr-flash-realtime'); setVoiceEnabled(false);",
    )

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.voiceModel).toBe('qwen3-asr-flash-realtime')
    expect(config.voiceEnabled).toBe(false)
  })
})
