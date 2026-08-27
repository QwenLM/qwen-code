/**
 * Visual evidence for PR #8439 (VP native mouse parity).
 *
 * Runs the bundled CLI against a mock model that always replies with a
 * markdown link, then injects raw SGR mouse bytes (the app is in VP mode with
 * mouse tracking on): a right-click on the link label must raise the in-app
 * context menu; Escape dismisses it.
 *
 * Prereq: the mock server must be listening, e.g.
 *   PORT=8795 node /tmp/vpm-final2/mock-openai-server.js
 *
 * Label geometry verified by E2E on a 120x40 terminal: the `Example Domain`
 * label renders at row 13, cols 9–22 (mid-label col 16).
 */
import type { ScenarioConfig } from '../scenario-runner.js';

const MOCK_PORT = 8795;

// SGR right-button press/release at col 16, row 13 (1-based).
const RIGHT_PRESS = '\u001b[<2;16;13M';
const RIGHT_RELEASE = '\u001b[<2;16;13m';

export default {
  name: 'vp-context-menu',
  spawn: [
    'bash',
    '-c',
    `TMUX= CI= CONTINUOUS_INTEGRATION= FORCE_HYPERLINK=1 BROWSER=echo ` +
      `node dist/cli.js ` +
      `--auth-type openai ` +
      `--openai-base-url http://127.0.0.1:${MOCK_PORT}/v1 ` +
      `--openai-api-key sk-mock -m mock-model --approval-mode yolo`,
  ],
  terminal: {
    cols: 120,
    rows: 40,
    title: 'qwen-code — VP context menu',
    cwd: '../../..',
  },
  flow: [
    // Dismiss the startup "Built-in Provider Update" dialog if it appears
    // (Escape = "Remind me later"). Harmless when no dialog is shown.
    { sleep: 6000, key: 'Escape' },
    // A following `key` step disables auto-Enter, so submit explicitly.
    {
      type: 'reply with exactly one line: See [Example Domain](https://example.com/) for details.',
    },
    { sleep: 1000, key: 'Enter' },
    // Right-click on the link label → context menu appears.
    { sleep: 500, key: [RIGHT_PRESS, RIGHT_RELEASE] },
    { capture: '02-menu-open.png' },
    // Escape dismisses the menu.
    { key: 'Escape' },
    { capture: '03-menu-closed.png' },
  ],
  gif: false,
} satisfies ScenarioConfig;
