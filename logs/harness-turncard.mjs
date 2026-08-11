// Clicks the per-message "Copy" button (TurnCard/message action, untouched by PR 8747)
// in the same built app, to show whether the remaining navigator.clipboard call sites still fail.
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { setupEnvDirs, launch, OUT, LABEL } from './lib.mjs'

const dirs = setupEnvDirs(LABEL)
fs.writeFileSync(path.join(dirs.workspace, 'verification-note.md'), '# Verification note\n\nbody\n')

const { app, win } = await launch(dirs)
const logs = []
win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
await win.waitForTimeout(8000)

const MSG = `TURNCARD-COPY-PAYLOAD-${LABEL}`
const composer = win.locator('[contenteditable="true"]').first()
await composer.click()
await composer.type(MSG, { delay: 20 })
await win.keyboard.press('Enter')
await win.waitForTimeout(5000)

execSync(`printf %s 'CLIPBOARD-BEFORE-${LABEL}' | pbcopy`)
const pid = app.process().pid
execSync(
  `osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true'`,
)
await win.waitForTimeout(1500)

const bubble = win.locator('div.group\\/message').first()
await bubble.hover().catch(() => {})
await win.waitForTimeout(800)
await win.screenshot({ path: path.join(OUT, `tc-1-hover-${LABEL}.png`) })

const copyBtn = win.locator('button[title="Copy"]').first()
const found = (await copyBtn.count()) > 0
if (found) {
  await copyBtn.click({ timeout: 8000, force: true })
  await win.waitForTimeout(1500)
  await win.screenshot({ path: path.join(OUT, `tc-2-clicked-${LABEL}.png`) })
}
const clip = execSync('pbpaste').toString()
const result = {
  label: LABEL,
  messageCopyButtonFound: found,
  clipboardAfterClick: clip.slice(0, 120),
  clipboardMatchesMessage: clip.includes(MSG),
  copyErrorsInConsole: logs.filter((l) => /Failed to copy|NotAllowed|clipboard/i.test(l)).slice(-6),
}
console.log('RESULT', JSON.stringify(result, null, 1))
fs.writeFileSync(path.join(OUT, `turncard-${LABEL}.json`), JSON.stringify(result, null, 2))
await app.close()
