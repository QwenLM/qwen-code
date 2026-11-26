# Mods written for Claude Code 2.1.332

Design: [docs/design/2026-11-26-mod-claude-code-2-1-332-shapes.md](../../docs/design/2026-11-26-mod-claude-code-2-1-332-shapes.md).

## Setup

- Build and bundle: `npm run build && npm run bundle`.
- Isolated `HOME`; `.qwen/settings.json` sets `experimental.mods: true`, turns folder trust off, and disables auto update and usage statistics.
- A loopback OpenAI-compatible fixture answers `OK` and logs every request. Interactive runs use the model name `qwen3-coder-plus` so the context window is known.
- Probe plugins, each installed with `qwen extensions install <dir> --consent`:
  - `p-stop`: hooks `session.stop`, and logs at `session.start`.
  - `p-alias`: registers `{name: 'pa', aliases: ['pa2']}`; `command.run` answers `pa ran as <e.command>`.
  - `p-term`: registers `{name: 'pt', isTerminalOnly: true, isHidden: true}`; answers with `isTextDisplayOnly: true`.
  - `p-inval`: calls `$.ui.invalidate('tool.offer')` at `session.start`.
  - `p-by`: answers `turn.complete` with `{...next, text: 'note from p-by', by: ['p-by']}`.
  - `p-band`: an `AbovePrompt` tree with `maxLines: 1`, `maxLines: 2`, `wrap: 'clip'`, a Box with `overflowX: 'scroll'` and `mono`, and two `Progress` elements (one at 3 of 10, one with no value).
  - Claude Code's token-weather sample, unchanged. It is used locally only and not committed: the sample repository carries no license.

## Test groups

### Headless (`qwen -p … --output-format json`)

1. `say hi` with every probe but `p-band` installed:
   - exit 0;
   - `ui_log` lines `Hooks for unsupported events will not run: session.stop`, `p-alias registered`, `p-inval ok`, `p-term registered`, `note from p-by`.
2. `/pa hi` and `/pa2 hi`: result `pa ran as pa`; no model request.
3. `/pt`: exit 1, error result `The command "/pt" is not supported in this mode.`; no model request.

### Interactive (tmux, 100×40)

4. Ink, with `p-band` alone. The band shows:
   - the one-row Text cut with `…`;
   - two rows of the `maxLines: 2` Text;
   - the clip and scroll Texts cut at the edge with `…`;
   - `Indexing ███░░░░░░░ 30%`;
   - `Waiting …`.
5. OpenTUI (`QWEN_TUI_RENDERER=opentui` under Bun): the same band, with end cuts unmarked as OpenTUI draws them.
6. token-weather alone, after one prompt, in Ink and OpenTUI: `☀  Clear  0% of context  1.2k / 1M   last turns █`.

## Baseline (main `a37a7612c9`, before the change)

- 1: exit 1 before any model request, `Mod p-stop: Error: Mod event not supported: session.stop`. No Mod runs. Without `p-stop`:
  - `p-alias` and `p-term` log `Invalid Mod command specification.`;
  - `p-inval` logs the invalidate refusal;
  - the `p-by` note is missing.
- 2: both prompts go to the model.
- 4: the band is blank, and `$.ui.resolve(e).Progress` is `undefined`.
- 6: passes. The sample uses nothing new.

## Results (after the change, final bundle)

- All groups 1–6 pass as described.
- In both Ink and OpenTUI, typing `/pa2 there` shows `pa ran as pa`, and `/pt` runs (`pt ran`).
- The same probe with `blur: 1` on its scroller draws no band: `blur` is refused until its placement rules are checked.
- `integration-tests/cli/mods-claude-332.test.ts` covers 1–3 on the bundled CLI.
