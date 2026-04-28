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
│   │  ███ QWEN ASCII ███  │         │  ① Title:   >_ Qwen Code (vX.Y.Z)   │  │
│   │  ███   ART ART  ███  │         │                                     │  │
│   │  ███ QWEN ASCII ███  │         │  ② Status:  Qwen OAuth | qwen-coder │  │
│   │                      │         │  ③ Path:    ~/projects/example      │  │
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
- **B. Info panel** — a bordered box containing three lines:
  - **B①** Title: `>_ Qwen Code (vX.Y.Z)` — brand text + version suffix.
  - **B②** Status: `<auth display type> | <model> ( /model to change)`.
  - **B③** Path: a tildeified, shortened working directory.

The whole thing is wrapped by `<AppHeader>`, which already gates the
banner on `showBanner = !config.getScreenReader()` (screen-reader mode
falls back to plain output).

## Customization rules — what can change, what is locked

| Region | Today's source | Customization category | Rationale |
| --- | --- | --- | --- |
| **A. Logo column** | `shortAsciiLogo` (`AsciiArt.ts`) | **Replaceable + auto-hideable** | Pure brand surface. White-label needs full control over the visual. The existing "auto-hide on narrow terminals" fallback is preserved. |
| **B①. Title — brand text** (`>_ Qwen Code`) | Hard-coded in `Header.tsx` | **Replaceable** | Brand surface. The leading `>_` glyph is part of the existing brand; if a user wants it gone, they simply omit it from `customBannerTitle`. |
| **B①. Title — version suffix** (`(vX.Y.Z)`) | `version` prop | **Locked** | Critical for bug reports. Hiding it makes "what version are you on?" answerable only via `--version`, which is a real cost in support workflows. We trade a small white-label loss for support tractability. |
| **B②. Status line** (auth + model) | `formattedAuthType`, `model` props | **Locked** | Operational and security signal. Users must always see which credential is in use and which model will spend their tokens. Suppressing it is a footgun even for white-label scenarios. |
| **B③. Path line** (working directory) | `workingDirectory` prop | **Locked** | Operational. "Which directory am I in?" is a constant question; the banner is its canonical answer. |
| **Whole banner** (A + B) | `<Header>` mount in `AppHeader.tsx` | **Hideable** | A single `ui.hideBanner: true` skips both regions — same shape as the existing screen-reader gate. `<Tips>` continues to be governed independently by `ui.hideTips`. |

The matrix translates to three settings, no more:

| Setting | Default | Effect | Region affected |
| --- | --- | --- | --- |
| `ui.hideBanner` | `false` | Hides the entire banner (regions A + B). | A + B |
| `ui.customBannerTitle` | unset | Replaces the brand text in B①. The version suffix is still appended. Trimmed; an empty string means "use default". | B① brand text |
| `ui.customAsciiArt` | unset | Replaces region A. Three accepted shapes (see below). Falls back to default on any error. | A |

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

All three settings live under `ui` in `settings.json`. Both user-level
(`~/.qwen/settings.json`) and workspace-level (`.qwen/settings.json` in
the project root) are supported with the standard merge precedence
(workspace overrides user, system overrides workspace).

### Hide the banner entirely

```jsonc
{
  "ui": {
    "hideBanner": true
  }
}
```

The startup output skips both the logo column and the info panel. Tips
still render unless `ui.hideTips` is also `true`.

### Replace the brand title

```jsonc
{
  "ui": {
    "customBannerTitle": "Acme CLI"
  }
}
```

Renders as `Acme CLI (vX.Y.Z)` in the info panel. The `>_` glyph is
removed when a custom title is set; if you want it back, include it
yourself: `"customBannerTitle": ">_ Acme CLI"`.

### Replace the ASCII art — inline string

```jsonc
{
  "ui": {
    "customAsciiArt": "  ___  _    _  ____ \n / _ \\| |  / |/ _\\\n| |_| | |__| | __/\n \\___/|____|_|___|"
  }
}
```

Use `\n` to embed newlines inside the JSON string. The art is rendered
with the active gradient theme just like the default logo.

> **Don't have ASCII art handy?** Use any external generator and paste
> the result. The simplest path is `figlet`:
> `npx figlet -f "ANSI Shadow" "xxxCode" > brand.txt` and then point
> `customAsciiArt: { "path": "./brand.txt" }` at it. The CLI does not
> render text-to-art at runtime — see the *Out of scope* section for
> why.

### Replace the ASCII art — external file

```jsonc
{
  "ui": {
    "customAsciiArt": { "path": "./brand.txt" }
  }
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
      "large": { "path": "./brand-wide.txt" }
    }
  }
}
```

`large` is preferred when the terminal is wide enough; otherwise `small`
is used; otherwise the logo column is hidden (the existing two-column
fallback). Either tier may be a string or `{ path }`. Either tier may be
omitted: a missing tier simply falls through to the next step.

### Combine all three

```jsonc
{
  "ui": {
    "hideBanner": false,
    "customBannerTitle": "Acme CLI",
    "customAsciiArt": {
      "small": "  ACME\n  ----",
      "large": { "path": "./brand-wide.txt" }
    }
  }
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
       "customAsciiArt": …                      │   && !ui.hideBanner
     }                                          │
   }                                            ▼
        │                              <Header
        ▼                                customAsciiArt={resolved}
   loadSettings()                        customBannerTitle="Acme"
   merge user / workspace                version=… model=… authType=…
        │                                workingDirectory=… />
        ▼                                          │
   resolveCustomBanner(merged, paths)              ▼
   ┌─────────────────────────┐         packages/cli/src/ui/components/
   │ 1. normalize to         │         Header.tsx
   │    { small, large }     │           │
   │ 2. resolve each tier:   │           │  pick tier by
   │    string → as-is       │           │    availableTerminalWidth
   │    {path} → fs.read     │           │
   │      O_NOFOLLOW         │           ▼
   │      ≤ 64 KB            │         render Logo Column
   │ 3. sanitize:            │         render Info Panel:
   │    stripControlSeqs     │           Title  = customBannerTitle
   │    ≤ 200 lines × 200    │                 ?? '>_ Qwen Code'
   │    cols                 │           Status = locked
   │ 4. memoize by source    │           Path   = locked
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
     capped at 64 KB. Relative paths resolve against the *owning
     settings file's directory* — workspace settings against the
     workspace `.qwen/`, user settings against `~/.qwen/`. Read failure
     logs `[BANNER]` warn and falls back to default for that tier.
3. **Sanitize**. Pass each resolved string through
   `stripTerminalControlSequences` (shared with the session-title
   feature), trim trailing whitespace, then cap at 200 lines × 200
   columns. Anything beyond the cap is truncated and a `[BANNER]` warn
   is logged.
4. **Render-time tier selection**. In `Header.tsx`, given the resolved
   `small` and `large`, evaluate the existing width budget
   (`availableTerminalWidth ≥ logoWidth + logoGap + minInfoPanelWidth`):
   - Prefer `large` if it fits.
   - Else fall back to `small` if it fits.
   - Else hide the logo column entirely (the existing
     `showLogo = false` branch). The info panel still renders.
5. **Fallback**. If both tiers end up empty or invalid, render
   `shortAsciiLogo` as if no customization had been set. The CLI must
   never crash on a banner config error.

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

Three new properties are appended to the `ui` object in
`packages/cli/src/config/settingsSchema.ts`, immediately after
`shellOutputMaxLines` (around line 720):

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
customAsciiArt: {
  type: 'object',
  label: 'Custom ASCII Art',
  category: 'UI',
  requiresRestart: false,
  default: undefined,
  description:
    'Replace the default QWEN ASCII art. Accepts an inline string, {"path": "..."}, or {"small": ..., "large": ...} for width-aware selection.',
  showInDialog: false,
},
```

`hideBanner` mirrors the existing `hideTips` pattern (`showInDialog:
true`). The two free-form fields stay out of the in-app settings dialog
because a multi-line ASCII editor in the TUI dialog is its own project;
power users edit `settings.json` directly.

## Wiring changes

The implementation touch points are small. Each is described below with
the file and line range from the current `main`.

`packages/cli/src/ui/components/AppHeader.tsx:53` — extend `showBanner`:

```ts
const showBanner =
  !config.getScreenReader() && !settings.merged.ui?.hideBanner;
```

`packages/cli/src/ui/components/AppHeader.tsx:64-71` — pass the resolved
banner into `<Header>`:

```tsx
<Header
  version={version}
  authDisplayType={authDisplayType}
  model={model}
  workingDirectory={targetDir}
  customAsciiArt={resolvedCustomAsciiArt /* { small?, large? } */}
  customBannerTitle={resolvedCustomBannerTitle /* string | undefined */}
/>
```

`packages/cli/src/ui/components/Header.tsx:28-34` — extend `HeaderProps`:

```ts
interface HeaderProps {
  customAsciiArt?: { small?: string; large?: string };
  customBannerTitle?: string;
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

`packages/cli/src/ui/components/Header.tsx:144` — render the title from
the prop:

```tsx
<Text bold color={theme.text.accent}>
  {customBannerTitle && customBannerTitle.trim()
    ? customBannerTitle
    : '>_ Qwen Code'}
</Text>
```

**New file**: `packages/cli/src/ui/utils/customBanner.ts` — the resolver.
Exports:

```ts
export interface ResolvedBanner {
  asciiArt: { small?: string; large?: string };
  title?: string;
}

export function resolveCustomBanner(
  settings: LoadedSettings,
  paths: { userDir: string; workspaceDir?: string },
): ResolvedBanner;
```

The resolver does the normalization, file reads, sanitization, and
caching described in the resolution pipeline above. It is called once
during CLI startup and re-run on settings hot-reload events.

## Alternative approaches considered

Five shapes of this feature were considered. They are listed here so
future contributors understand the design space and can revisit the
choice if the constraints change.

### Option 1 — Three flat settings (RECOMMENDED, matches the issue)

```jsonc
{
  "ui": {
    "customAsciiArt": "...",        // string | {path} | {small,large}
    "customBannerTitle": "Acme CLI",
    "hideBanner": false
  }
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
      "asciiArt": { "path": "./brand.txt" }
    }
  }
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
    "bannerTemplate": "{{logo}}\n>_ {{title}} ({{version}})\n{{auth}} | {{model}}\n{{path}}"
  }
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

| Concern | Guard |
| --- | --- |
| ANSI / OSC-8 / CSI injection in art or title | `stripTerminalControlSequences` (shared with session-title) before render and before any cache write. |
| Oversize file freezes startup | 64 KB hard cap on file reads. |
| Pathological art freezes layout | 200 lines × 200 cols cap on each resolved string. Excess is truncated; a `[BANNER]` warn is logged. |
| Symlink redirect on the path form | `O_NOFOLLOW` on file reads (Windows: plain read-only; constant not exposed). |
| Missing or unreadable file | Catch, log `[BANNER]` warn, fall back to default. Never throw into the UI. |
| Title with newlines or excess length | Strip newlines, cap at 80 characters. |
| Race on settings reload | Resolution is memoized by source (path or string hash). Reloads invalidate cache for changed sources only. |

Failure mode summary: every soft failure ends in `shortAsciiLogo` (or
the locked default title) plus a debug-log warn. Hard failures
(thrown errors) are not allowed in any branch of the resolver.

## Out of scope

These were considered and deliberately deferred. Each can be a separate
follow-up if user demand surfaces.

| Item | Why not |
| --- | --- |
| Text-to-ASCII rendering (`{ text: "xxxCode" }` form) | Considered and rejected for v1. Adding this would require either a `figlet` runtime dependency (~2–3 MB unpacked once a usable set of fonts is included) or a vendored single-font renderer (~200 lines + a `.flf` font file we'd own). Both options bring ongoing surface area: font selection, font-license tracking, "my font doesn't render right on terminal X" issues, and CJK / wide-character handling. The driving use case for this feature (white-label / multi-tenant) almost always has a designer producing intentional ASCII art, not relying on a default figlet font. Users who want one-line generation can already get it with `npx figlet "xxxCode" > brand.txt` + `customAsciiArt: { "path": "./brand.txt" }` — same outcome, no added dependency, no support burden inside Qwen Code. If demand surfaces later this form is purely additive: extend `AsciiArtSource` to `string \| {path} \| {text, font?}` without breaking any existing config. |
| `/banner` slash command for live editing | The settings UI is the canonical edit surface. A live editor for multi-line ASCII art is its own project. |
| Custom gradient colors / per-line color overrides | Theme owns colors. A separate proposal can extend the theme contract; banner customization should not duplicate that surface. |
| URL-loaded ASCII art | Network fetch at startup is its own can of worms — failure modes, caching, security review. The file-path form is the lower-risk equivalent. |
| Animation (spinning logo, marquee title) | Adds rendering load and a11y concerns; nothing in the use cases needs it. |
| VSCode / Web UI banner parity | Those surfaces don't render the Ink banner today. If they grow a banner, this design is the reference. |
| Dynamic reload on file change | The resolver runs at startup and on settings reload only. Mid-session art changes are rare enough that "restart to take effect" is the acceptable trade. |
| Hiding only individual locked regions (version, auth, model, path) | These are operational signals; suppressing them harms support and security posture more than it helps white-label scenarios. |

## Verification plan

For the eventual implementation PR, the following end-to-end checks
should pass.

1. `~/.qwen/settings.json` with `customBannerTitle: "Acme CLI"` and an
   inline `customAsciiArt` string → `qwen` shows the new title and art;
   version suffix still present.
2. `hideBanner: true` → `qwen` starts with no banner; tips and chat
   render normally.
3. `customAsciiArt: { "path": "./brand.txt" }` in a workspace
   `settings.json`, with `brand.txt` next to it in `.qwen/` → loads
   from disk on workspace open.
4. `customAsciiArt: { "small": "...", "large": "..." }` → resize the
   terminal between wide / medium / narrow; large at wide widths,
   small at medium widths, logo column hidden at narrow widths, info
   panel always visible.
5. Inject `\x1b[31mhostile` into `customBannerTitle` → renders as
   literal text, not interpreted as red.
6. Point `path` at a missing file → CLI starts; `[BANNER]` warn
   appears in `~/.qwen/debug/<sessionId>.txt`; default art renders.
7. `npm test` and `npm run typecheck` pass for the CLI package; unit
   tests in `customBanner.test.ts` cover each accepted shape and each
   failure path (missing file, oversize file, ANSI injection, malformed
   object).
