/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview `/run-skill-generator` bundled skill — authors or improves
 * a per-project run skill that documents verified build, launch, runtime
 * driving, and troubleshooting steps.
 */

import {
  SHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../../tools/tool-names.js';
import { CONFIG_DIR } from '../../utils/paths.js';
import type { BundledSkillRegistrar } from './index.js';

const RUN_SKILL_GENERATOR_PROMPT = `Your job is to produce a **skill** at \`${CONFIG_DIR}/skills/run-<unit-name>/\`
that lets a future agent build, launch, and **drive** this project from
a clean machine.

The skill has two parts that live together:

\`\`\`
${CONFIG_DIR}/skills/run-<unit-name>/
  SKILL.md      ← agent-facing instructions — SHORT. Points at the driver.
  driver.mjs    ← (or driver.py, smoke.sh, … — or none: web apps use
                   curl off-the-shelf, and the heredoc in
                   SKILL.md is the script)
\`\`\`

That almost always means **writing code**, not just prose. If the app
has any interactive surface (GUI, TUI, long-running server, REPL), the
future agent needs a programmatic way to poke it. A markdown file by
itself cannot click a button — but sometimes the button-clicker
already exists: for web apps it's curl, for servers it's
curl. You build (or script) that harness now, commit it alongside
the skill, and the \`SKILL.md\` documents how to use it.

## Definition of done

You are done when **all** of these are true:

1. **You launched the app in this environment and interacted with it** —
   not its test suite, the actual running app.
2. **The interaction harness is committed** next to the skill. A driver
   script, a REPL wrapper, a smoke test, or the curl heredoc
   inline in \`SKILL.md\` — whatever you used to drive the app in step 1.
3. **The \`SKILL.md\` documents the harness** as the primary agent path —
   the section a future agent reads first is "run this driver / pipe
   these commands," not "run \`npm start\` and a window opens."
4. **Every code block in \`SKILL.md\` is a command you ran that worked.**
   This session. This environment. Not from the README, not inferred.

If you're about to write the skill and you don't have (1), **stop.** You
are about to paraphrase existing docs. That document already exists —
it's called the README, and the whole reason you're here is that it
wasn't enough.

## The deliverables are code AND docs

Typical output is a skill directory containing both:

\`\`\`
${CONFIG_DIR}/skills/run-<unit>/
  SKILL.md         ← SHORT. Points at the driver. Has the frontmatter
                     that lets the agent auto-load it when someone asks
                     to "run <unit>" or "check <unit>".
  driver.mjs       ← (or driver.py, smoke.sh, … — or none: web apps
                     use curl off-the-shelf, and the heredoc
                     in SKILL.md is the script)
\`\`\`

The driver lives **inside the skill directory** by default. They are a
pair — the skill's instructions and the code that implements them. A
driver that lives here is allowed to be a bit messier than production
code; it's agent tooling, not product surface.

**Graduation:** if the driver grows into something the project's own
test suite wants to reuse — shared launch helpers, a real e2e harness —
move it to \`scripts/\` or \`e2e/\` and update \`SKILL.md\` to reference the
new path. The skill stays; the driver finds a better home.

The exact shape depends on the project, but the principle is constant:
**the driver is the deliverable.** The \`SKILL.md\` is its man page. For
a web app, the driver is curl. For a desktop app, the driver is a custom
REPL under tmux. For a server, the driver is curl. Whatever shape it
takes, without something that reaches into the running app, the skill is
a description of a window nobody can touch.

## Where the skill goes

The skill lives at \`${CONFIG_DIR}/skills/run-<unit-name>/\`, where
\`<unit>\` is the directory for **one deployable thing** — an app, a
service, a library.

- **Single-project repo:** \`${CONFIG_DIR}/skills/run-<repo-name>/\` at repo root.
- **Large repo with many apps:** one per app, colocated —
  \`apps/billing/${CONFIG_DIR}/skills/run-billing/\`,
  \`apps/desktop/${CONFIG_DIR}/skills/run-desktop/\`.
- **App with multiple binaries:** still **one** skill at the app's
  root with a section per binary. They share setup.

If you're not sure where the unit boundary is, **ask the user.**

Slugify the directory name: lowercase, dashes for spaces, no slashes
(\`run-billing-api\`, not \`run-billing/api\`). The directory name and
the frontmatter \`name:\` should match — that's the slash command.

## Process

### 0. Find any existing skill about running this app

List the project's skills with their descriptions:

\`\`\`bash
d=$PWD; while :; do
  grep -Hm1 '^description:' "$d"/${CONFIG_DIR}/skills/*/SKILL.md 2>/dev/null
  [ -e "$d/.git" ] || [ "$d" = / ] && break
  d=$(dirname "$d")
done
\`\`\`

If one is about launching/driving this app — whatever it's named —
**refine, don't rewrite**: verify its claims, fix what's wrong, add
what's missing, preserve what works. Re-run the driver if there is
one. Keep its existing name.

If none exists, decide where to create it (see above) and continue.

### 1. Discover — and treat every claim as disprovable

Figure out what you're authoring for:

- Manifest right here (\`package.json\`, \`go.mod\`, \`pyproject.toml\`…) and
  it's one self-contained thing → this is the unit.
- Looks like a mega-repo root (\`apps/\`, \`packages/\`, \`services/\`) →
  **ask which one.** List candidates, let them pick, \`cd\` there.
- Genuinely ambiguous → ask.

Survey the usual places: \`README.md\`, \`package.json\` scripts,
\`Dockerfile\`, \`Makefile\`, \`.github/workflows/\`, \`CONTRIBUTING.md\`. CI
configs are often more accurate than READMEs.

**Every claim in existing docs is a hypothesis.** Especially the
negative ones:

| When docs say… | What you do |
|---|---|
| "Requires macOS/Windows" | Launch it anyway. Apps rarely refuse to start — they crash on a missing lib, which package managers fix. |
| "Requires a GPU" | Try software rendering. Electron/Chrome fall back with \`--disable-gpu\`. |
| "Requires a paid account / feature flag" | The gate is code you can read. Find it (env var? build define?) and patch it for your local run. Document the patch. |
| "Run \`npm start\`" | That's the human path (spawns a window, waits forever). Find or build the *programmatic* path. |

### 2. Execute — and BUILD the harness you need

The app is going to fight you.
That fight is the content of the skill.

Keep a running \`NOTES.md\` as you go. Every error → every fix → every
command that finally worked. This scratchpad becomes the
Troubleshooting section.

**Work up to a real interaction:**

- **Install + build.** When something's missing, note the exact
  install command that fixed it.
- **Launch the app.** Not the test suite — the app.
- **Build a harness to drive it.** You need a handle on the running
  app that lets you send input and observe output programmatically.
- **Do one real user flow end-to-end.** Hit the endpoint. See the
  result. **Actually look at the output.** If it's an error, you're
  not done.
- **Then run the tests.** Unit tests are a sanity check, not the main
  event.
- **Stop cleanly.**

**Obstacles are content.** Each gets a bullet in Gotchas and (often)
a helper in your driver. The gold standard is a Gotchas section full
of things nobody could have guessed.

**The driver script gets committed alongside the skill.** It is not
scaffolding. It is the way future agents (and humans) will drive this
app.

### 3. Write SKILL.md

Short. Point at the driver.

**The frontmatter matters.** The \`name:\` becomes the slash command
(\`/run-billing\`). The \`description:\` is what the agent scans to decide
whether to auto-load this skill — put the **verbs an agent would
actually type** in it: "run," "start," "build," "test."
Generic descriptions ("helpful utilities for billing") won't match.

Body structure:

1. One-paragraph intro: what this app is, how it's driven.
2. **Prerequisites** — the exact install commands you ran.
3. **Build** — the exact commands, in order. Include any patches you
   had to apply (feature gates, config overrides).
4. **Run (agent path)** — FIRST. How to launch the driver, what
   commands it accepts. This is the section the next agent will actually
   use.
5. **Run (human path)** — SECOND, if different. Brief.
6. **Gotchas** — the battle scars. The things that look like they
   should work but don't, and the workaround. If this section is
   generic, you didn't fight hard enough.
7. **Troubleshooting** — symptom → fix. Only errors you actually hit.

Keep it **verified** (you ran it), **prescriptive** (one path, not
options), **honest** (flaky? slow? say so).

### 4. Verify

Fresh shell, \`cd\` into the unit, follow the skill's \`SKILL.md\`
line-by-line without deviating. Any improvisation = a gap. Fix it.

## Project-type patterns

| Project type | Driver shape |
|---|---|
| Web server / API | Background-launch + curl-based smoke script |
| CLI tool | Representative-args smoke script, check exit codes + output |
| TUI / interactive terminal | tmux wrapper: send-keys / capture-pane |
| Desktop GUI (Electron/Tauri) | REPL driver under xvfb, screenshots |
| Browser-driven | dev server + headless browser script |
| Library / SDK | Import-and-call smoke script |

## What to include

- **Prerequisites** — OS packages, runtimes, tools. The exact ones.
- **Setup** — install deps, configure, any patches.
- **Build** — compile/bundle.
- **Run (agent path)** — the driver. Commands.
- **Direct invocation** — if callable: how to import and run internal
  code without the full app.
- **Run (human path)** — if meaningfully different.
- **Test** — the test suite command.
- **Gotchas** — non-obvious traps you hit.
- **Troubleshooting** — error → fix.
- **The driver itself** — committed in the skill dir (or graduated
  to \`scripts/\`/\`e2e/\`); referenced from \`SKILL.md\` either way.

## What to leave out

- **Anything you didn't run.** Full stop.
- **Documented happy paths for platforms you're not on.**
- **Exhaustive options.** One working path.
- **Architecture prose.** That's other docs.
- **Generic troubleshooting.** Only include errors you actually hit and fixed.

## Red flags — you are about to ship the wrong thing

Stop and reconsider if:

- **Your skill has no driver/smoke script** to point at, and the app
  is interactive. The next agent has no way to drive it.
- **Your skill reads like the README.** Same structure, same
  commands, same caveats. You paraphrased.
- **Your Troubleshooting section is generic.** Real execution produces
  specific, weird errors. Generic errors = you didn't execute.
- **Everything worked first try.** Either this project is trivially
  simple, or you ran the test suite and called it done.
`;

export function registerRunSkillGeneratorSkill(
  registrar: BundledSkillRegistrar,
  shellToolName: string = SHELL_TOOL_NAME,
): void {
  registrar.registerBundledSkill({
    name: 'run-skill-generator',
    description:
      "Author or improve the run-<unit> skill — a per-project skill that tells agents how to build, launch, and drive this project's app. Use when the user asks to set up the project, get it running, write run instructions, or verify build/run steps work from a clean environment.",
    location: 'bundled',
    body: '',
    userInvocable: true,
    disableModelInvocation: true,
    allowedTools: [shellToolName, WRITE_FILE_TOOL_NAME],
    async getBody(args) {
      let prompt = RUN_SKILL_GENERATOR_PROMPT;
      if (args) {
        prompt += `\n## User Request\n\n${args}`;
      }
      return prompt;
    },
  });
}
