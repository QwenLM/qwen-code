/**
 * Functional parity matrix (M5-②): build a REAL Config from the user's
 * ~/.qwen/settings.json (loadSettings + loadCliConfig), load the interactive
 * command registry exactly as the OpenTUI dispatcher does, and assert the key
 * slash commands are present. This is the functional (command-surface) parity
 * guard. Run: bun packages/cli/scripts/opentui-command-parity.ts
 */
import { loadSettings } from '../src/config/settings.js';
import { loadCliConfig } from '../src/config/config.js';
import { loadInteractiveCommands } from '../src/ui/opentui/slash-dispatch.js';

const KEY_COMMANDS = [
  'help',
  'stats',
  'skills',
  'model',
  'theme',
  'settings',
  'permissions',
  'approval-mode',
  'effort',
  'memory',
  'statusline',
  'clear',
];

async function main() {
  const cwd = process.cwd();
  const loaded = loadSettings(cwd);
  const config = await loadCliConfig(loaded.merged as never, {} as never, cwd);
  const cmds = await loadInteractiveCommands(config);
  const names = new Set(cmds.map((c) => c.name));
  console.log(`interactive commands loaded: ${names.size}`);
  let ok = true;
  for (const k of KEY_COMMANDS) {
    const present = names.has(k);
    console.log(`/${k.padEnd(14)} ${present ? 'Y' : 'N'}`);
    if (!present) ok = false;
  }
  console.log(ok ? 'COMMAND PARITY PASS' : 'COMMAND PARITY FAIL');
  process.exit(ok ? 0 : 1);
}

void main();
