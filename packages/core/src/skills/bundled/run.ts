/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview `/run` bundled skill — launches and drives the project's
 * application so the user (or model) can observe code changes in the
 * running system rather than just in tests.
 */

import { SHELL_TOOL_NAME } from '../../tools/tool-names.js';
import { CONFIG_DIR } from '../../utils/paths.js';
import type { BundledSkillRegistrar } from './index.js';

const RUN_PROMPT = `**Running means launching the actual app and interacting with it** —
not the test suite, not an \`import\` of an internal function and a
\`console.log\`. The app as a user (human or programmatic) would meet
it: the CLI at its command, the server at its socket, the GUI at its
window.

## First: does a project skill already cover this?

A project skill that launches this app is the repo's verified path —
its author already cold-started and committed what worked: the exact
install commands, the env vars, the patches, the driver. Use it
instead of rediscovering.

\`\`\`bash
d=$PWD; while :; do
  grep -Hm1 '^description:' "$d/${CONFIG_DIR}/skills"/*/SKILL.md 2>/dev/null
  [ -e "$d/.git" ] || [ "$d" = / ] && break
  d=$(dirname "$d")
done
\`\`\`

- **One describes launching/driving this app** → read that SKILL.md
  and follow it verbatim. Don't paraphrase; don't skip the patches.
- **Mega-repo, several plausible, no clear match** → ask the user
  which unit to run.
- **Stale** (fails on mechanics unrelated to your task) → tell the
  user; offer to refresh it via \`/run-skill-generator\`.
- **Nothing about running** → fall back to the patterns below.

## Otherwise: match the shape, use the pattern

Pick the row closest to your project. Each example walks through
launch + first interaction; ignore any trailing "write the skill"
section — you're using the recipe, not authoring one.

| Project type | Handle |
|---|---|
| CLI tool | direct invocation, exit code, stdin/stdout |
| Web server / API | background launch + \`curl\` smoke |
| TUI / interactive terminal | tmux \`send-keys\` / \`capture-pane\` |
| Desktop GUI (Electron/Tauri) | Playwright REPL under xvfb |
| Browser-driven | dev server + headless browser script |
| Library / SDK | import-and-call smoke script at the package boundary |

If nothing fits, start from the closest match and adapt.

## Drive it, don't just launch it

Launching with no interaction proves the entrypoint resolves. That's
not running the app — it's typechecking with extra steps. Drive it to
a point where a user would see something:

- CLI → type a representative command, check the exit code and output.
- Server → hit the route the diff touches with \`curl\`, read the body.
- TUI → \`send-keys\` a navigation, \`capture-pane\` the result.
- GUI → click the button, screenshot the window. **Look at the
  screenshot.** A blank frame is a failure to launch.

If the fallback pattern didn't work out of the box — you had to
install packages, set env vars, patch config, or write a driver —
recommend \`/run-skill-generator\` in your report so that work gets
captured as a project skill. If it just worked, don't.
`;

export function registerRunSkill(
  registrar: BundledSkillRegistrar,
  shellToolName: string = SHELL_TOOL_NAME,
): void {
  registrar.registerBundledSkill({
    name: 'run',
    description:
      "Launch and drive this project's app to see a change working. Use when asked to run, start, or screenshot the app, or to confirm a change works in the real app (not just tests).",
    location: 'bundled',
    body: '',
    userInvocable: true,
    disableModelInvocation: false,
    allowedTools: [shellToolName],
    argumentHint: '[what to observe]',
    async getBody(args) {
      let prompt = RUN_PROMPT;
      if (args) {
        prompt += `\n## User Request\n\n${args}`;
      }
      return prompt;
    },
  });
}
