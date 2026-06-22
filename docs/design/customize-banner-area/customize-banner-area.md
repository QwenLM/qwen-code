# Customize Banner Area Design

> Allow users to replace the QWEN ASCII art, replace the brand title, and
> hide the banner entirely — without letting them suppress the operational
> data (version, auth, model, working directory) that makes Qwen Code
> debuggable and trustworthy.

## Overview

The Qwen Code CLI prints a banner at startup containing a QWEN ASCII logo
and a bordered info panel. Several real-world use cases want some control
over this surface:

- **White-label / third-party brand integration**: enterprises and teams
  embedding Qwen Code into their own products want to display their brand
  identity rather than the default "Qwen Code".
- **Personalization**: individuals want to match the terminal banner to a
  team standard or their own taste.
- **Multi-tenant / multi-instance distinction**: in shared environments,
  different teams want a quick visual signal of which instance they are
  in.

The design stance is simple: **brand chrome is replaceable; operational
data is not**. Customization should let users put their own branding on
top, not let them silence the information that makes a session
debuggable. That stance drives every "what can change vs. what is locked"
decision in the rest of this document.

This is tracked by [issue #3005](https://github.com/QwenLM/qwen-code/issues/3005).

## Banner region taxonomy

Today the banner is rendered by `Header` (mounted from `AppHeader`) and
breaks into the following regions:

```
  marginX=2                                                           marginX=2
  │                                                                          │
  ▼                                                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ┌──── Logo Column ─────┐  gap=2  ┌──── Info Panel (bordered) ──────────┐  │
│   │                      │         │                                     │  │
│   │  ███ QWEN ASCII ███  │         │  ① Title:    >_ Qwen Code (vX.Y.Z)  │  │
│   │  ███   ART ART  ███  │         │  ② Subtitle: «blank, or override»   │  │
│   │  ███ QWEN ASCII ███  │         │  ③ Status:   Qwen OAuth | qwen-…    │  │
│   │                      │         │  ④ Path:     ~/projects/example     │  │
│   └──────── A ───────────┘         └──────────────── B ──────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                              region: AppHeader
                          │ Tips component renders below (governed by ui.hideTips) │
```

The two top-level boxes are:

- **A. Logo column** — a single ASCII art block with a gradient. Sourced
  today from `shortAsciiLogo` in
  `packages/cli/src/ui/components/AsciiArt.ts`.
- **B. Info panel** — a bordered box containing four rows. The second
  row is a blank visual spacer by default, optionally swapped for a
  caller-supplied subtitle:
  - **B①** Title: `>_ Qwen Code (vX.Y.Z)` — brand text + version suffix.
  - **B②** Subtitle / spacer: blank single-space row by default. When
    `ui.customBannerSubtitle` is set, that string takes this row (e.g.
    a fork might use `Built-in DataWorks Official Skills`).
  - **B③** Status: `<auth display type> | <model> ( /model to change)`.
  - **B④** Path: a tildeified, shortened working directory.

The whole thing is wrapped by `<AppHeader>`, which already gates the
banner on `showBanner = !config.getScreenReader()` (screen-reader mode
falls back to plain output).

## Customization rules — what can change, what is locked

| Region                                      | Today's source                      | Customization category          | Rationale                                                                                                                                                                                                    |
| ------------------------------------------- | ----------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. Logo column**                          | `shortAsciiLogo` (`AsciiArt.ts`)    | **Replaceable + auto-hideable** | Pure brand surface. White-label needs full control over the visual. The existing "auto-hide on narrow terminals" fallback is preserved.                                                                      |
| **B①. Title — brand text** (`>_ Qwen Code`) | Hard-coded in `Header.tsx`          | **Replaceable**                 | Brand surface. The leading `>_` glyph is part of the existing brand; if a user wants it gone, they simply omit it from `customBannerTitle`.                                                                  |
| **B①. Title — version suffix** (`(vX.Y.Z)`) | `version` prop                      | **Locked**                      | Critical for bug reports. Hiding it makes "what version are you on?" answerable only via `--version`, which is a real cost in support workflows. We trade a small white-label loss for support tractability. |
| **B②. Subtitle / spacer row**               | blank by default                    | **Replaceable**                 | Pure brand / context surface. Used by white-label forks to label the build (e.g. "Built-in DataWorks Official Skills"). Sanitized like the title; one line only — no layout-breaking newlines.               |
| **B③. Status line** (auth + model)          | `formattedAuthType`, `model` props  | **Locked**                      | Operational and security signal. Users must always see which credential is in use and which model will spend their tokens. Suppressing it is a footgun even for white-label scenarios.                       |
| **B④. Path line** (working directory)       | `workingDirectory` prop             | **Locked**                      | Operational. "Which directory am I in?" is a constant question; the banner is its canonical answer.                                                                                                          |
| **Whole banner** (A + B)                    | `<Header>` mount in `AppHeader.tsx` | **Hideable**                    | A single `ui.hideBanner: true` skips both regions — same shape as the existing screen-reader gate. `<Tips>` continues to be governed independently by `ui.hideTips`.                                         |

The matrix translates to four settings, no more:

| Setting                   | Default | Effect                                                                                                                               | Region affected |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `ui.hideBanner`           | `false` | Hides the entire banner (regions A + B).                                                                                             | A + B           |
| `ui.customBannerTitle`    | unset   | Replaces the brand text in B①. The version suffix is still appended. Trimmed; an empty string means "use default".                   | B① brand text   |
| `ui.customBannerSubtitle` | unset   | Replaces the blank spacer row B② with a one-line subtitle. Sanitized; capped at 160 characters; empty means "keep the blank spacer". | B② spacer       |
| `ui.customAsciiArt`       | unset   | Replaces region A. Three accepted shapes (see below). Falls back to default on any error.                                            | A               |

What is **not** offered, by design:

- No setting hides only the version suffix.
- No setting hides only the auth/model line.
- No setting hides only the path line.
- No setting changes the gradient colors of the logo (theme owns that).
- No setting reorders or restructures the info panel.

If the implementation later needs to expose any of those, they should be
new fields with their own justification — not derived from the three
fields above.

## User configuration guide — how to modify

### Limits at a glance

A handful of caps apply to every banner customization. Keep them in mind
before hand-crafting art so the resolver doesn't truncate or reject
your input.

| What                             | Limit                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title character count**        | **80 characters max** (post-sanitize). Anything longer is truncated and a `[BANNER]` warn is logged. Newlines and control chars are stripped before this length is counted. |
| **Subtitle character count**     | **160 characters max** (post-sanitize). Same cleanup pipeline as the title; same `[BANNER]` warn on truncation.                                                             |
| **ASCII art block size**         | **200 lines × 200 columns max** per tier. Anything larger is truncated to fit and a `[BANNER]` warn is logged.                                                              |
| **ASCII art file size on disk**  | **64 KB max**. Larger files are read up to the cap; the rest is ignored.                                                                                                    |
| **ASCII art width that renders** | Driven by terminal columns at startup, **not** a fixed character count. See "How wide can the logo be?" below for the formula and per-terminal numbers.                     |

There is **no fixed character-count limit on the ASCII art** — only the
column / line caps above and the per-startup width budget. A 17-character
brand name that would render comfortably in one font may need stacking or
a denser font in another; the limiting factor is visual width, not letters.

### Where settings live

All four settings live under `ui` in `settings.json`. Both user-level
(`~/.qwen/settings.json`) and workspace-level (`.qwen/settings.json` in
the project root) are supported with the standard merge precedence
(workspace overrides user, system overrides workspace).

`customAsciiArt` is special-cased: rather than treating the whole object
as one value that the higher-precedence scope replaces, the resolver
walks scopes per-tier. If user settings define `{ small }` and workspace
settings define `{ large }`, both contribute — `small` from user,
`large` from workspace. This keeps two things working at once:

1. Each `{ path }` entry resolves against the file that declared it
   (workspace `.qwen/` vs. user `~/.qwen/`); the merged view alone would
   lose that scope information.
2. Users can keep a default `large` tier in their personal settings and
   override only `small` per-workspace, without restating the whole
   object.

When the same tier is defined in multiple scopes, normal precedence
applies (system > workspace > user). Setting `customAsciiArt` to a bare
string or `{ path }` in any scope still fills both tiers in that scope.

### Hide the banner entirely

```jsonc
{
  "ui": {
    "hideBanner": true,
  },
}
```

The startup output skips both the logo column and the info panel. Tips
still render unless `ui.hideTips` is also `true`.

### Replace the brand title

```jsonc
{
  "ui": {
    "customBannerTitle": "Acme CLI",
  },
}
```

Renders as `Acme CLI (vX.Y.Z)` in the info panel. The `>_` glyph is
removed when a custom title is set; if you want it back, include it
yourself: `"customBannerTitle": ">_ Acme CLI"`.

### Add a brand subtitle

```jsonc
{
  "ui": {
    "customBannerSubtitle": "Built-in DataWorks Official Skills",
  },
}
```

Renders the subtitle on its own row, in the secondary text color, in
place of the blank spacer that normally sits between the title and the
auth/model line:

```
┌─────────────────────────────────────────────────────────┐
│ DataWorks DataAgent (vX.Y.Z)                            │  ← B① title
│ Built-in DataWorks Official Skills                      │  ← B② subtitle
│ Qwen OAuth | qwen-coder ( /model to change)             │  ← B③ status
│ ~/projects/example                                      │  ← B④ path
└─────────────────────────────────────────────────────────┘
```

Constraints:

- Single line only. Newlines and other control bytes are stripped /
  folded to spaces so a paste accident can't break the info-panel
  layout.
- Sanitized capped at 160 characters (looser than the title cap because
  taglines / "powered by" lines often run a bit long).
- Leave the field unset (or set it to an empty string / whitespace)
  to keep the existing blank spacer row — back-compat is the default.
- The subtitle does not change which lines are locked; auth, model,
  and working directory are always visible regardless of subtitle
  state.

### Replace the ASCII art — inline string

```jsonc
{
  "ui": {
    "customAsciiArt": "  ___  _    _  ____ \n / _ \\| |  / |/ _\\\n| |_| | |__| | __/\n \\___/|____|_|___|",
  },
}
```

Use `\n` to embed newlines inside the JSON string. The art is rendered
with the active gradient theme just like the default logo.

> **Don't have ASCII art handy?** Use any external generator and paste
> the result. The simplest path is `figlet`:
> `npx figlet -f "ANSI Shadow" "xxxCode" > brand.txt` and then point
> `customAsciiArt: { "path": "./brand.txt" }` at it. The CLI does not
> render text-to-art at runtime — see the _Out of scope_ section for
> why.

### Replace the ASCII art — external file

```jsonc
{
  "ui": {
    "customAsciiArt": { "path": "./brand.txt" },
  },
}
```

Avoids JSON-escaping a multi-line string. Path resolution rules:

- **Workspace settings**: relative paths resolve against the workspace
  `.qwen/` directory.
- **User settings**: relative paths resolve against `~/.qwen/`.
- Absolute paths are used as-is.
- The file is read **once at startup**, sanitized, and cached. Editing
  the file mid-session does not re-render the banner — restart the CLI.

### Replace the ASCII art — width-aware

```jsonc
{
  "ui": {
    "customAsciiArt": {
      "small": "  ACME\n  ----",
      "large": { "path": "./brand-wide.txt" },
    },
  },
}
```

`large` is preferred when the terminal is wide enough; otherwise `small`
is used; otherwise the logo column is hidden (the existing two-column
fallback). Either tier may be a string or `{ path }`. Either tier may be
omitted: a missing tier simply falls through to the next step.

### How wide can the logo be? — the size budget

There is no hard character-count limit on the title or art. There is a
**width budget** driven by terminal columns and an absolute hard cap to
keep a malformed file from freezing layout:

| Knob                                             | Limit                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| Terminal columns at startup                      | Whatever the user's terminal reports.                                 |
| Container outer margin                           | 4 cols (2 left + 2 right).                                            |
| Gap between logo and info panel                  | 2 cols.                                                               |
| Info panel minimum width                         | 44 cols (40 path + border + padding).                                 |
| **Available logo width** (per tier, render-time) | `terminalCols − 4 − 2 − 44 = terminalCols − 50`.                      |
| Hard cap on each art tier (post-sanitize)        | 200 cols × 200 lines. Anything beyond is truncated + `[BANNER]` warn. |
| Hard cap on `customBannerTitle` (post-sanitize)  | 80 chars. Anything beyond is truncated + `[BANNER]` warn.             |

Reading the budget at common terminal widths:

| Terminal cols | Max logo width that renders | What that means in practice                                           |
| ------------- | --------------------------- | --------------------------------------------------------------------- |
| 80            | 30                          | Most figlet "ANSI Shadow" letters are ~7–11 cols — 3 letters max.     |
| 100           | 50                          | A short word in ANSI Shadow (~6 letters), or two short words stacked. |
| 120           | 70                          | Stacked multi-line word art fits comfortably.                         |
| 200           | 150                         | Long inline strings like full product names in ANSI Shadow fit.       |

Two practical implications when designing your art:

1. **A multi-word brand often won't render as a single ANSI Shadow line
   on most terminals.** At ~7–9 cols per ANSI Shadow letter, even a
   12-character brand like `Custom Agent` is roughly 95 cols of art on
   one line — already more than a 100-col terminal can spare alongside
   the info panel. Either stack the words on multiple lines, pick a
   denser figlet font, or use a compact single-line text decoration
   like `▶ Custom Agent ◀`.
2. **Use the width-aware `{ small, large }` form** when a single tier
   would force you to choose between "looks great wide / dies narrow"
   and "looks fine narrow / wastes space wide". The example below
   stacks the words for a ≥104-col terminal in `large` and falls
   through to a 16-col single-line decoration in `small`.

```jsonc
{
  "ui": {
    "customBannerTitle": "Custom Agent",
    "customAsciiArt": {
      "small": "▶ Custom Agent ◀",
      "large": { "path": "./banner-large.txt" },
    },
  },
}
```

Where `banner-large.txt` contains the stacked-words ANSI Shadow output
(~54 cols × 12 lines), e.g., generated by:

```bash
( npx figlet -f "ANSI Shadow" CUSTOM
  npx figlet -f "ANSI Shadow" AGENT ) > banner-large.txt
```

### Combine all three

```jsonc
{
  "ui": {
    "hideBanner": false,
    "customBannerTitle": "Acme CLI",
    "customAsciiArt": {
      "small": "  ACME\n  ----",
      "large": { "path": "./brand-wide.txt" },
    },
  },
}
```

### How to verify your change

1. Save `settings.json` and start a fresh `qwen` session — banner
   resolution runs once at startup.
2. Resize the terminal to confirm `small` / `large` tiers swap as
   expected, and that the logo column disappears at very narrow widths.
3. If something does not appear as expected, look at
   `~/.qwen/debug/<sessionId>.txt` (the symlink `latest.txt` points to
   the current session) and grep for `[BANNER]` — every soft failure
   logs a warn line with the underlying reason.

## Resolution pipeline

```
   settings.json                              packages/cli/src/ui/components/
   ─────────────                              ──────────────────────────────
   {                                          AppHeader.tsx
     "ui": {                                    │
       "hideBanner": false,                     │  showBanner =
       "customBannerTitle": "Acme",             │      !screenReader
       "customBannerSubtitle": "Built-in …",    │   && !ui.hideBanner
       "customAsciiArt": …                      │
     }                                          │
   }                                            ▼
        │                              <Header
        ▼                                customAsciiArt={resolved.asciiArt}
   loadSettings()                        customBannerTitle={resolved.title}
   merge user / workspace                customBannerSubtitle={resolved.subtitle}
        │                                version=… model=… authType=…
        ▼                                workingDirectory=… />
   resolveCustomBanner(settings)                  │
   ┌─────────────────────────┐                    ▼
   │ 1. normalize to         │         packages/cli/src/ui/components/
   │    { small, large }     │         Header.tsx
   │ 2. resolve each tier:   │           │
   │    string → as-is       │           │  pick tier by
   │    {path} → fs.read     │           │    availableTerminalWidth
   │      O_NOFOLLOW         │           ▼
   │      ≤ 64 KB            │         render Logo Column
   │ 3. sanitize art:        │         render Info Panel:
   │    stripControlSeqs     │           Title    = customBannerTitle
   │    ≤ 200 lines × 200    │                   ?? '>_ Qwen Code'
   │    cols                 │           Subtitle = customBannerSubtitle
   │ 4. sanitize title +     │                   ?? blank spacer row
   │    subtitle (single-    │           Status   = locked
   │    line, ≤ 80 / 160     │           Path     = locked
   │    chars)               │
   │ 5. memoize by source    │
   └─────────────────────────┘
```

The five-step resolution algorithm runs once when settings are loaded
and again only on settings reload events:

1. **Normalize**. A bare `string` or `{ path }` becomes
   `{ small: x, large: x }`. A `{ small, large }` object passes through.
2. **Resolve each tier**. For each `AsciiArtSource`:
   - If it is a string, use it as-is.
   - If it is `{ path }`, read the file synchronously with `O_NOFOLLOW`
     defense (Windows: plain read-only — the constant is not exposed),
     capped at 64 KB. Relative paths resolve against the _owning
     settings file's directory_ — workspace settings against the
     workspace `.qwen/`, user settings against `~/.qwen/`. Read failure
     logs `[BANNER]` warn and falls back to default for that tier.
3. **Sanitize**. A banner-specific stripper drops OSC / CSI / SS2 / SS3
   leaders and replaces every other C0 / C1 control byte (and DEL) with
   a space, while preserving `\n` so multi-line art survives. Trim
   trailing whitespace per line, then cap at 200 lines × 200 columns.
   Anything beyond the cap is truncated and a `[BANNER]` warn is logged.
4. **Render-time tier selection**. In `Header.tsx`, given the resolved
   `small` and `large`, evaluate the existing width budget
   (`availableTerminalWidth ≥ logoWidth + logoGap + minInfoPanelWidth`):
   - Prefer `large` if it fits.
   - Else fall back to `small` if it fits.
   - Else, **if the user supplied any custom art**, hide the logo column
     entirely (the existing `showLogo = false` branch) — falling back to
     the bundled QWEN logo here would silently undo a white-label
     deployment on narrow terminals. The info panel still renders.
   - Else (no custom art was supplied at all) fall through to
     `shortAsciiLogo` and let the existing width gate decide whether to
     show or hide the default logo.
5. **Fallback**. If both tiers end up empty or invalid because of soft
   failures (missing file, sanitization rejected everything, malformed
   config), behave as if no customization had been set: render
   `shortAsciiLogo` and follow the default-logo width gate. The CLI
   must never crash on a banner config error.

Pseudocode for tier selection:

```ts
function pickTier(
  small: string | undefined,
  large: string | undefined,
  availableWidth: number,
  logoGap: number,
  minInfoPanelWidth: number,
): string | undefined {
  for (const candidate of [large, small]) {
    if (!candidate) continue;
    const w = getAsciiArtWidth(candidate);
    if (availableWidth >= w + logoGap + minInfoPanelWidth) {
      return candidate;
    }
  }
  return undefined; // logo column hidden
}
```

## Settings schema additions

Four new properties are appended to the `ui` object in
`packages/cli/src/config/settingsSchema.ts`, immediately after
`shellOutputMaxLines`:

```ts
hideBanner: {
  type: 'boolean',
  label: 'Hide Banner',
  category: 'UI',
  requiresRestart: false,
  default: false,
  description: 'Hide the startup ASCII banner and info panel.',
  showInDialog: true,
},
customBannerTitle: {
  type: 'string',
  label: 'Custom Banner Title',
  category: 'UI',
  requiresRestart: false,
  default: '' as string,
  description:
    'Replace the default ">_ Qwen Code" title shown in the banner info panel. The version suffix is always appended.',
  showInDialog: false,
},
customBannerSubtitle: {
  type: 'string',
  label: 'Custom Banner Subtitle',
  category: 'UI',
  requiresRestart: false,
  default: '' as string,
  description:
    'Optional subtitle line rendered between the banner title and the auth/model line. When unset, the info panel keeps its blank spacer row.',
  showInDialog: false,
},
customAsciiArt: {
  type: 'object',
  label: 'Custom ASCII Art',
  category: 'UI',
  requiresRestart: false,
  default: undefined,
  description:
    'Replace the default QWEN ASCII art. Accepts an inline string, {"path": "..."}, or {"small": ..., "large": ...} for width-aware selection.',
  showInDialog: false,
  // The runtime accepts a union the SettingDefinition `type` field can't
  // express. The override is emitted verbatim by the JSON-schema generator
  // so VS Code accepts every documented shape (string, {path}, or
  // {small,large}) without flagging the bare-string form.
  jsonSchemaOverride: { /* string | {path} | {small,large} oneOf … */ },
},
```

`hideBanner` mirrors the existing `hideTips` pattern (`showInDialog:
true`). The three free-form fields (title, subtitle, art) stay out of
the in-app settings dialog because a multi-line ASCII editor in the
TUI dialog is its own project; power users edit `settings.json`
directly.

## Wiring changes

The implementation touch points are small. Each is described below with
the file and line range from the current `main`.

`packages/cli/src/ui/components/AppHeader.tsx:53` — extend `showBanner`:

```ts
const showBanner = !config.getScreenReader() && !settings.merged.ui?.hideBanner;
```

`packages/cli/src/ui/components/AppHeader.tsx` — pass the resolved
banner into `<Header>`:

```tsx
<Header
  version={version}
  authDisplayType={authDisplayType}
  model={model}
  workingDirectory={targetDir}
  customAsciiArt={resolvedBanner?.asciiArt /* { small?, large? } */}
  customBannerTitle={resolvedBanner?.title /* string | undefined */}
  customBannerSubtitle={resolvedBanner?.subtitle /* string | undefined */}
/>
```

`packages/cli/src/ui/components/Header.tsx` — extend `HeaderProps`:

```ts
interface HeaderProps {
  customAsciiArt?: { small?: string; large?: string };
  customBannerTitle?: string;
  customBannerSubtitle?: string;
  version: string;
  authDisplayType?: AuthDisplayType;
  model: string;
  workingDirectory: string;
}
```

`packages/cli/src/ui/components/Header.tsx:45-46` — pick the tier before
computing `logoWidth`, with the existing default as the floor:

```ts
const tier = pickTier(
  customAsciiArt?.small,
  customAsciiArt?.large,
  availableTerminalWidth,
  logoGap,
  minInfoPanelWidth,
);
const displayLogo = tier ?? shortAsciiLogo;
```

`packages/cli/src/ui/components/Header.tsx` — render the title from
the prop, and use the subtitle prop in place of the blank spacer row
when set:

```tsx
<Text bold color={theme.text.accent}>
  {customBannerTitle ? customBannerTitle : '>_ Qwen Code'}
</Text>
…
{customBannerSubtitle ? (
  <Text color={theme.text.secondary}>{customBannerSubtitle}</Text>
) : (
  <Text> </Text>
)}
```

**New file**: `packages/cli/src/ui/utils/customBanner.ts` — the resolver.
Exports:

```ts
export interface ResolvedBanner {
  asciiArt: { small?: string; large?: string };
  title?: string;
  subtitle?: string;
}

export function resolveCustomBanner(settings: LoadedSettings): ResolvedBanner;
```

The resolver does the normalization, file reads, sanitization, and
caching described in the resolution pipeline above. It is called once
during CLI startup and re-run on settings hot-reload events. Per-scope
file paths come from `settings.system.path` / `settings.workspace.path`
/ `settings.user.path` directly so each `{ path }` resolves against
the file that declared it; workspace settings are skipped entirely
when `settings.isTrusted` is false.

## Alternative approaches considered

Five shapes of this feature were considered. They are listed here so
future contributors understand the design space and can revisit the
choice if the constraints change.

### Option 1 — Three flat settings (RECOMMENDED, matches the issue)

```jsonc
{
  "ui": {
    "customAsciiArt": "...", // string | {path} | {small,large}
    "customBannerTitle": "Acme CLI",
    "hideBanner": false,
  },
}
```

- **Effect**: minimal user-facing surface; exactly what the issue asks
  for.
- **Pros**: zero learning curve; trivially documented; consistent with
  existing flat `ui.*` properties (`hideTips`, `customWittyPhrases`,
  etc.).
- **Cons**: three top-level keys that conceptually belong together
  aren't grouped; future banner-only knobs (gradient, subtitle) would
  add more siblings to `ui` instead of nesting cleanly.

### Option 2 — Nested `ui.banner` namespace

```jsonc
{
  "ui": {
    "banner": {
      "hide": false,
      "title": "Acme CLI",
      "asciiArt": { "path": "./brand.txt" },
    },
  },
}
```

- **Effect**: same capabilities as Option 1, organized by feature.
- **Pros**: clean namespace for future banner-only knobs; easier
  discovery via `/settings`.
- **Cons**: diverges from the issue's exact wording; existing UI
  settings are mostly flat (only `ui.accessibility` and `ui.statusLine`
  nest), so consistency is mixed; adds one nesting level for users to
  remember.

### Option 3 — Banner profile presets + slot overrides

```jsonc
{
  "ui": {
    "bannerProfile": "minimal" | "default" | "branded" | "hidden",
    "banner": { /* slot overrides for 'branded' */ }
  }
}
```

- **Effect**: users pick from named presets; advanced users override
  slots inside a chosen profile.
- **Pros**: nice onboarding UX; presets ship with the CLI.
- **Cons**: significant complexity; presets are a maintenance
  commitment; the issue asks for raw customization, not curation.

### Option 4 — Whole-banner override (single string template)

```jsonc
{
  "ui": {
    "bannerTemplate": "{{logo}}\n>_ {{title}} ({{version}})\n{{auth}} | {{model}}\n{{path}}",
  },
}
```

- **Effect**: single freeform template with locked variables filled in.
- **Pros**: maximum flexibility for non-standard layouts.
- **Cons**: re-implements layout in user-space; loses Ink's two-column
  resilience to terminal width; very easy to write a template that
  breaks on narrow terminals; large blast radius for a small feature.

### Option 5 — Plugin / hook API

Expose a banner-renderer hook through the extensions system.

- **Effect**: code-level customization; extensions can render anything.
- **Pros**: maximum power; lets enterprises ship a sealed branding
  plugin.
- **Cons**: large API surface; needs security review for arbitrary
  terminal rendering; massively over-scoped for the issue.

### Recommendation

**Option 1** is recommended. It satisfies the issue verbatim, slots into
the existing `ui.*` style, and avoids forcing a nested-namespace
decision before we know what other banner-only knobs would actually
look like. If future siblings start accumulating, migrating to Option 2
is additive — `ui.banner.title` and `ui.customBannerTitle` can coexist
during a deprecation window.

## Security & failure handling

The custom banner content is rendered verbatim in the terminal AND, in
the path-form, read from disk. Both surfaces are attack-reachable if a
hostile or compromised settings file is loaded. The same threat model
that drives the session-title feature applies here.

| Concern                                                 | Guard                                                                                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ANSI / OSC-8 / CSI injection in art, title, or subtitle | Banner-specific stripper (`sanitizeArt` / `sanitizeSingleLine`): drops OSC / CSI / SS2 / SS3 leaders and replaces every other C0 / C1 control byte (and DEL) with a space. Applied before render and cache write. |
| Oversize file freezes startup                           | 64 KB hard cap on file reads.                                                                                                                                                                                     |
| Pathological art freezes layout                         | 200 lines × 200 cols cap on each resolved string. Excess is truncated; a `[BANNER]` warn is logged.                                                                                                               |
| Symlink redirect on the path form                       | `O_NOFOLLOW` on file reads (Windows: plain read-only; constant not exposed).                                                                                                                                      |
| Missing or unreadable file                              | Catch, log `[BANNER]` warn, fall back to default. Never throw into the UI.                                                                                                                                        |
| Title or subtitle with newlines / excess length         | Newlines folded to spaces; capped at 80 (title) / 160 (subtitle) characters.                                                                                                                                      |
| Untrusted workspace influencing rendering or file reads | When `settings.isTrusted` is false, the resolver skips `settings.workspace` entirely (mirrors the trust gate that `settings.merged` applies).                                                                     |
| Race on settings reload                                 | Resolution is memoized by source (path or string hash) per call. Reloads re-run the resolver and re-read affected files.                                                                                          |

Failure mode summary: every soft failure ends in `shortAsciiLogo` (or
the locked default title) plus a debug-log warn. Hard failures
(thrown errors) are not allowed in any branch of the resolver.

## Out of scope

These were considered and deliberately deferred. Each can be a separate
follow-up if user demand surfaces.

| Item                                                               | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text-to-ASCII rendering (`{ text: "xxxCode" }` form)               | Considered and rejected for v1. Adding this would require either a `figlet` runtime dependency (~2–3 MB unpacked once a usable set of fonts is included) or a vendored single-font renderer (~200 lines + a `.flf` font file we'd own). Both options bring ongoing surface area: font selection, font-license tracking, "my font doesn't render right on terminal X" issues, and CJK / wide-character handling. The driving use case for this feature (white-label / multi-tenant) almost always has a designer producing intentional ASCII art, not relying on a default figlet font. Users who want one-line generation can already get it with `npx figlet "xxxCode" > brand.txt` + `customAsciiArt: { "path": "./brand.txt" }` — same outcome, no added dependency, no support burden inside Qwen Code. If demand surfaces later this form is purely additive: extend `AsciiArtSource` to `string \| {path} \| {text, font?}` without breaking any existing config. |
| `/banner` slash command for live editing                           | The settings UI is the canonical edit surface. A live editor for multi-line ASCII art is its own project.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Custom gradient colors / per-line color overrides                  | Theme owns colors. A separate proposal can extend the theme contract; banner customization should not duplicate that surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| URL-loaded ASCII art                                               | Network fetch at startup is its own can of worms — failure modes, caching, security review. The file-path form is the lower-risk equivalent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Animation (spinning logo, marquee title)                           | Adds rendering load and a11y concerns; nothing in the use cases needs it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| VSCode / Web UI banner parity                                      | Those surfaces don't render the Ink banner today. If they grow a banner, this design is the reference.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Dynamic reload on file change                                      | The resolver runs at startup and on settings reload only. Mid-session art changes are rare enough that "restart to take effect" is the acceptable trade.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Hiding only individual locked regions (version, auth, model, path) | These are operational signals; suppressing them harms support and security posture more than it helps white-label scenarios.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Verification plan

For the eventual implementation PR, the following end-to-end checks
should pass.

1. `~/.qwen/settings.json` with `customBannerTitle: "Acme CLI"` and an
   inline `customAsciiArt` string → `qwen` shows the new title and art;
   version suffix still present.
2. `customBannerSubtitle: "Built-in Acme Skills"` → the subtitle row
   renders between the title and the auth/model line in the secondary
   text color; auth, model, and path still visible. Unsetting it
   restores the blank spacer row (back-compat).
3. `hideBanner: true` → `qwen` starts with no banner; tips and chat
   render normally.
4. `customAsciiArt: { "path": "./brand.txt" }` in a workspace
   `settings.json`, with `brand.txt` next to it in `.qwen/` → loads
   from disk on workspace open.
5. `customAsciiArt: { "small": "...", "large": "..." }` → resize the
   terminal between wide / medium / narrow; large at wide widths,
   small at medium widths, logo column hidden at narrow widths, info
   panel always visible.
6. Inject `\x1b[31mhostile` into `customBannerTitle` _and_
   `customBannerSubtitle` → both render as literal text, not
   interpreted as red.
7. Point `path` at a missing file → CLI starts; `[BANNER]` warn
   appears in `~/.qwen/debug/<sessionId>.txt`; default art renders.
8. Open the worktree with workspace trust off → workspace-defined
   `customAsciiArt` (including `{ path }` entries) is silently
   ignored; user-scope settings still apply.
9. `npm test` and `npm run typecheck` pass for the CLI package; unit
   tests in `customBanner.test.ts` cover each accepted shape and each
   failure path (missing file, oversize file, ANSI injection, malformed
   object).
