# Mod reads of the environment and settings, and telemetry

Design: [docs/design/2026-11-27-mod-env-settings-telemetry.md](../../docs/design/2026-11-27-mod-env-settings-telemetry.md).

## Setup

- Build and bundle: `npm run build && npm run bundle`.
- Isolated `HOME`. `~/.qwen/settings.json` sets:
  - `experimental.mods: true`;
  - folder trust off, auto update off;
  - `general.vimMode: true`;
  - `security.auth.apiKey: "sk-probe-secret"`;
  - `env: { PROBE_TOKEN: "tok-secret", EDITOR: "vim" }`.
- `OPENAI_API_KEY=sk-env-secret` in the process environment.
- Probe plugin `p-reads`, installed with `qwen extensions install <dir> --consent`. Its `/probe` command calls, one per line:
  - `$.env.get('HOME')`, `$.env.get('OPENAI_API_KEY')` and `$.env.get('PROBE_TOKEN')`;
  - `$.settings.read({ key })` for `general`, `security` and `env`;
  - the keys of `$.settings.read({ source: 'user' })`;
  - `$.telemetry.log({ event, props })` and `$.telemetry.mark({ feature, kind })`.

## Test groups

### Headless (`qwen -p '/probe' --output-format text`)

1. Each line answers:
   - `HOME` is the isolated home;
   - both credential variables are `undefined`;
   - `general` holds `vimMode: true`;
   - `security.auth` has no `apiKey`;
   - `env` is `{ EDITOR: "vim" }`;
   - telemetry resolves to `undefined`.
2. No secret (`sk-probe-secret`, `tok-secret`, `sk-env-secret`) appears on stdout or stderr.
3. With `--debug`, the debug log holds `telemetry.log (not sent): …` and `telemetry.mark (not sent): …`.

### Interactive (tmux, Ink and OpenTUI)

4. `/probe` shows the same lines as group 1.
5. With `NO_COLOR=1`, a probe command answering `presentation` shows `isColorless: true`; without it the field is absent.

## Baseline (Qwen Code 0.27.4, global CLI)

- 1: every line fails with `Mod API not supported: $.env.get`, `$.settings.read`, `$.telemetry.log` or `$.telemetry.mark`.

## Results (after the change, final bundle)

- 1–3 pass on the final bundle: `HOME` is the isolated home; `OPENAI_API_KEY` and `PROBE_TOKEN` read `undefined`; `security.auth` is `{selectedType: "openai"}`; `env` is `{EDITOR: "vim"}`; telemetry resolves to `undefined`. No secret appears on stdout or stderr. The debug log holds `[MODS] [p-reads] telemetry.log (not sent): {"event":"probe_ran","props":{"n":1},"to":"anthropic"}` and the `telemetry.mark` line.
- 4 passes in Ink and OpenTUI (`QWEN_TUI_RENDERER=opentui` under Bun): the same lines as group 1.
- 5 passes in both: with `NO_COLOR=1`, `/pres` shows `{"isFullscreen":true,"columns":120,"isColorless":true}`; without it, `{"isFullscreen":true,"columns":120}`.
- `integration-tests/cli/mods-env-settings-telemetry.test.ts` covers 1–2 on the bundled CLI.
