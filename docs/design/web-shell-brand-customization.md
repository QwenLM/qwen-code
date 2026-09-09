# Web Shell brand customization

## Goal

A deployment can rename the Web Shell product and replace its logo without
editing source or rebuilding. Two channels: `settings.json` for the standalone
shell served by `qwen serve`, and a React prop for hosts that embed
`@qwen-code/web-shell`. An untouched installation renders exactly what it
renders today.

## Current state

Every structural brand point is a literal. The product name appears in the
sidebar brand row and its version tooltip
(`client/components/sidebar/WebShellSidebar.tsx`), in the welcome header
(`client/components/WelcomeHeader.tsx`), as the About panel's version row label
(the `about.qwenCode` message), and in the document title
(`client/index.html`). The logo exists as two hand-duplicated copies of the
same artwork: an inline SVG component in the sidebar, and a percent-encoded
data URI favicon in `index.html`. Nothing reads a name or a logo from
configuration, no code path writes `document.title`, and the standalone entry
passes `sidebar: true`, which resolves to sidebar options with no branding key.

The one existing hook is `WebShellSidebarBranding.render`, which replaces the
sidebar's brand row wholesale. It is an escape hatch for embedded hosts, not
configuration: it cannot reach the welcome header, the version tooltip, the
About row, the document title, or the favicon, and the standalone shell has no
way to supply it. It stays supported and unchanged.

## Configuration surface

Brand lives under the existing `ui` section as two string leaves:

```json
{
  "ui": {
    "brand": {
      "name": "QiuQiu Code",
      "logoPath": "~/.qwen/brand/logo.svg"
    }
  }
}
```

Both default to the empty string, which means "use the built-in brand". An
absent or empty `name` keeps `Qwen Code`; an absent or empty `logoPath` keeps
the current Qwen mark in both the sidebar and the favicon. The two leaves are
independent — a deployment may rename without replacing the artwork, or the
reverse.

Both are declared with `showInDialog: false` and are not added to the web
shell's opt-in exposure list, so they never reach the in-browser Settings page.
Brand is deployment configuration edited in `settings.json`, not a preference a
viewer of one workspace should be able to change for everyone else, and the
Settings page has no control type for "path to an SVG on the daemon's disk".
Nesting under `ui` rather than adding a top-level section keeps the change out
of the schema's asserted top-level key list.

## Scope, and why workspace is excluded

Brand resolves from the System Defaults, User and System settings layers only,
in the precedence `mergeSettings` gives them. The Workspace layer is not
consulted, and the daemon route passes `skipWorkspaceSettings` so that layer is
never even read off disk — the exclusion is structural rather than a filter
applied after merging.

A workspace `.qwen/settings.json` commonly arrives from a cloned repository
that the person opening the shell did not write. Letting that file rename the
product would let a repo control what every connected browser displays, and
letting it name a file for the daemon to read and inline into every client
would turn the shell into a rendering surface for repository-controlled
content. `general.voice.keytermsFile` already excludes the workspace layer for
the same reason, and brand follows that precedent.

The same boundary closes the placeholder side door. `loadSettings` substitutes
`$VAR`/`${VAR}` placeholders from the process-wide environment, which
`loadEnvironment` populates workspace-first at boot — so an operator-layer
`${BRAND_NAME}` would resolve to whatever a repository's `.qwen/.env` or `env`
block supplied. Brand keys therefore compare each layer's substituted value
against its pre-substitution snapshot (`originalSettings`) and refuse with a
warning whenever substitution actually fired. A placeholder that resolves to
itself (the variable is unset) is kept verbatim, so a typo'd variable surfaces
as the literal text rather than silently falling back. Every other string leaf
keeps the documented substitution behavior; brand is the exception because the
exclusion is its whole point.

This is also why the merged settings value is not used: the merged value is
exactly the thing that would reintroduce the excluded layer.

## Alignment with the terminal banner settings

The TUI already has white-label settings — `ui.customBannerTitle`,
`ui.customBannerSubtitle` and `ui.customAsciiArt` — resolved by
`ui/utils/customBanner.ts`. The Web Shell resolver follows their conventions
rather than inventing parallel ones, so one deployment's branding behaves the
same way on both surfaces:

- a single-line branding string is stripped of terminal escape sequences, has
  its whitespace folded, and is clamped to 80 characters, the same cap the
  banner title uses;
- a relative asset path resolves against the directory of the settings file
  that declared it, and soft-fails with a warning when that layer has no owning
  file;
- a non-regular file is refused before it is opened, because opening a FIFO
  read-only blocks until a writer connects.

The Web Shell resolver is strictest where it differs. It rejects an oversized
logo where the banner reader truncates it — a truncated SVG is not a smaller
SVG, it is a corrupt one. It also refuses a file with more than one hard link,
opens with `O_NONBLOCK`, and re-verifies the file's stat identity on the
descriptor before reading, where the banner reader re-checks only that what it
opened is still a regular file.

Symlink handling is _not_ a divergence, and an earlier draft of this document
claimed it was: the banner reader stats with `lstatSync` and refuses anything
that is not a regular file, so a symlinked art file is already rejected there
before the open. Both resolvers refuse symlinks; they only differ in whether
the refusal gets its own message.

## Logo resolution

A new consumer service resolves `logoPath` at request time. Nothing in settings
loading dereferences it; resolution happens at the point of use, matching how
every other path-valued setting in this repository behaves.

The path expands a leading `~`, and a relative path resolves against the
declaring settings file's directory as described above. The file must be a
regular file, not a symlink, with a single hard link, and must open without
following symlinks and re-verify its stat identity before the bytes are read.
The content is capped at 32 KiB — a logo is a handful of paths, and the cap
keeps the resulting data URI well inside both a JSON payload and a localStorage
write. The parsed document's root element must be an `<svg>` that declares the
SVG namespace — the default `xmlns="http://www.w3.org/2000/svg"`, or an
`xmlns:svg` binding on a prefix-bound `<svg:svg>` root, which is equally
renderable — tolerating a BOM, an XML declaration, comments, and a DOCTYPE
with or without an internal subset before it. This is a renderability check,
not a sanitizer. The check is quote-aware, so `>`, `[` and `]` inside quoted
literals do not confuse it, and a namespace-shaped substring inside another
attribute's value does not satisfy it. A root with no non-empty `viewBox`
and no explicit positive, non-percentage width/height is accepted with an
advisory on the daemon's stderr, because the browser cannot scale such
artwork into the fixed sidebar box and may render it blank. A rejection
yields a warning and no logo, so a bad path degrades to the built-in mark
instead of failing the request.

The resolved SVG is percent-encoded into a `data:image/svg+xml` URI on the
server. A data URI rather than a served file because the shell's Content
Security Policy already permits `img-src 'self' data: blob:`, while the
daemon's static server exposes only `/assets/*` and `/` — the same constraint
that made the existing favicon a data URI. No policy change is needed.

## Rendering custom logos as images, not markup

The client renders a custom logo as an `img` element whose `src` is the data
URI. It never injects the SVG as markup.

This is the load-bearing security decision in the design, and it is what makes
the absence of a sanitizer correct rather than negligent. SVG loaded as an
image — in an `img` element or as a favicon — cannot run script in any current
browser. SVG injected into the document can. Because no code path injects
resolver output into the DOM as markup, an SVG containing script or event
handlers is inert by construction, and the resolver does not need to parse and
rewrite the artwork's internals.

The built-in Qwen mark stays an inline SVG component. It is first-party
artwork, and staying inline lets it inherit color from the surrounding CSS.
Only custom logos take the image path.

## Delivery

A new daemon route returns the resolved brand. Ownership classification:
process-global. It takes neither a workspace selector nor a session id, the
same classification as the sessionless user-level language route, because the
value derives from user-global configuration. The response carries an optional
name and an optional logo data URI; either may be absent, and absence means the
client uses its built-in default.

The route is not folded into `/capabilities`. That envelope's documented
position is that clients probe by connecting rather than reading ambient
settings into it, precisely because doing so would make the envelope depend on
the user's home configuration — and brand is the user's home configuration. It
is not folded into `/workspace/settings` either: brand is deliberately not
workspace-scoped, that channel reports merged effective values which would
reintroduce the excluded layer, and a settings descriptor has no place for a
derived data URI that is not the value the user wrote.

The client fetches it on connection setup, inside the workspace provider beside
the capabilities fetch, and exposes it as an optional field on the workspace
context. It stays out of the connection status machine: a failed brand fetch
leaves the built-in brand in place and never marks the connection as errored.
The call is deferred into a promise chain rather than made directly, because the
SDK is a peer dependency and a host on an older SDK has a client with no brand
method at all — a synchronous `TypeError` thrown out of a mount effect would
white-screen the shell over a cosmetic feature.

There is no live-reload subscription. The daemon does not watch settings files
at all — the settings watcher is instantiated only by the interactive terminal
— so no setting propagates from an external file edit today, and brand matching
that behavior is consistency rather than a gap. A page reload picks up a change.
A write through any settings route still bumps the client's settings signal,
which does not re-fetch brand; brand is re-read on the next connection. One
bounded retry exists purely for transient transport failures — a retryable
rejection is re-asked once after a short delay, and the connection recovery
path re-asks through `refreshBrand` when the brand is still missing — neither
touches the live-reload boundary.

## Title and favicon before first paint

The document title and favicon live in `index.html`, which the browser parses
before any React code runs. To keep a renamed deployment from flashing the
default name in the tab on every load, brand follows the mechanism theme
already uses:

- when the resolved brand arrives, the standalone entry writes it to a
  `localStorage` key, ignoring storage failures the same way the theme and
  language writers do;
- the pre-paint inline script in `index.html` reads that key and applies the
  title and swaps the icon link's href before first paint.

The first-ever load still shows the default title until the fetch resolves.
Every load after that is flash-free. This is the identical trade-off theme
makes today.

The document title derives from the name rather than getting its own setting:
when a brand name is present the title is that name followed by the existing
suffix, and when it is absent the current literal is untouched. One knob, not
two.

No server-side HTML rewriting is introduced. The static handler keeps sending
`index.html` as a plain file, so there is no response body mutation and no
interaction with its ETag, Content-Length, or security headers. Getting the
title from a cached localStorage value is what makes that possible. Verified
against a running daemon: the served document still carries the built-in title
and the built-in favicon bytes.

Un-setting a logo is the one asymmetric case. The built-in favicon exists only
as a literal in `index.html`, so once the entry has overwritten the icon link's
href it cannot be restored from within the same page. The entry therefore clears
the cache when the resolved brand has no logo, and the next load — with no cache
to apply — gets the built-in favicon back from the document itself. The title
needs no such handling, because the entry derives the default from the shared
built-in name constant and restores it immediately.

Only the standalone entry writes to `document`. It learns the resolved brand
through a callback prop, the same shape as the existing theme and language
change callbacks, which keeps every `document` write out of the component an
embedding host mounts.

The callback must not fire while the brand fetch is in flight: the workspace
context reports `undefined` both then and on a daemon without the route, and
firing on the in-flight case would reset the tab title and drop the cache on
every load, flashing branded to default to branded. But "no value yet" and "no
value, ever" are genuinely different outcomes, and an earlier draft of this
design conflated them — pointed at a daemon too old to have the route, a
previously cached brand would have stayed in the tab chrome forever because
nothing could report the absence. The provider therefore exposes a settled flag
beside the value, and the callback fires on a host prop or on that flag. The
flag flips only on a definitive outcome — an answer (a brand or an empty
object), or a 404 from a daemon that has no route and never will — because a
retryable failure (a 503 while the deferred runtime starts, a 429, a transport
blip, an old SDK with no `brand()`) is unknown, not absent: settling there
would report an authoritative empty brand, reset the tab title mid-session and
delete the cache over a blip. A blip is retried once after a short delay and
re-asked through the workspace-error recovery path when the brand is still
missing, but a settings-signal bump never re-fetches it. A settled-with-no-brand
outcome reports an empty brand, which clears stale cached chrome; an unsettled
one reports nothing, which is what keeps the flash away. An older daemon's 404
and a host withdrawing its `brand` prop both settle, so both invalidate the
cache the same way.

## The prop channel

The shell component accepts an optional brand carrying a name and a logo node.
The prop wins over the fetched value, mirroring the precedence the existing
theme and language resolution effects already implement.

The prop's logo is a React node, not a data URI, because an embedding host owns
its own document and its own Content Security Policy and may pass inline
markup, an image, or a component. Hosts also own their tab title and favicon:
the shell writes to `document` only from the standalone entry, never from
inside the component, so an embedded shell cannot hijack its host page's title.

Overall precedence, highest first: the existing sidebar branding render
override, then the brand prop, then the fetched value, then the built-in
default.

## What the name replaces

The brand name drives exactly the structural points where the product names
itself: the sidebar brand row, the sidebar footer's version tooltip, the
welcome header title, the About panel's version row label, and the document
title in the standalone shell. The brand logo drives the sidebar mark and the
favicon.

## What it deliberately does not replace

The auth provider label reading `Qwen OAuth` names the identity provider, not
the product. A white-labeled shell still authenticates against Qwen's OAuth
service, and renaming that string would misdescribe the auth flow to the person
about to grant it access.

The roughly forty localized strings that mention the product inside longer
prose — settings page descriptions, channel setup, live host installation,
workflows, skill descriptions — are out of scope by decision. Covering them
requires a message-override mechanism on the localization provider, which does
not exist and is a materially larger change. The consequence is stated plainly
so it is not discovered later: a renamed shell still says `Qwen Code` in body
copy.

One localized string is removed rather than left behind: the About panel's
version-row label existed only to say the product name, and the brand name now
supplies it, so keeping the key would leave an orphan in both language tables.

The terms-of-service and documentation links, and the bug report URL, point at
real Qwen resources and keep pointing there.

The public CSS custom properties, the data attributes, and the localStorage key
prefixes are contracts, and renaming the storage keys would discard every
existing user's saved preferences for no visible gain. The theme wire values
that contain the product name are persisted into the theme setting; renaming
them is a settings compatibility migration, not cosmetics.

The terminal CLI is out of scope and already served: it has its own
white-label settings for the banner title, subtitle and ASCII logo. The web
shell imports nothing from core or from the CLI package and shares no brand
constant with them, so this change neither renames the terminal product nor
depends on it. A deployment that wants both surfaces rebranded configures both,
which is why the resolver mirrors the banner settings' conventions.

The welcome title's gradient is already a public CSS custom property a host can
override without this feature.

## Files affected

| Layer                                                                     | Change                                                                                                                            |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/config/settingsSchema.ts`                               | two string leaves under `ui`, both `showInDialog: false`                                                                          |
| `packages/vscode-ide-companion/schemas/settings.schema.json`              | regenerated, not hand-edited                                                                                                      |
| `packages/cli/src/services/web-shell-brand.ts`                            | new resolver: layer selection, name sanitization, hardened SVG read, data URI encoding                                            |
| `packages/cli/src/serve/routes/brand.ts`                                  | new process-global route                                                                                                          |
| `packages/cli/src/serve/server.ts`                                        | route registration                                                                                                                |
| `packages/sdk-typescript/src/daemon/types.ts`                             | new response type                                                                                                                 |
| `packages/sdk-typescript/src/daemon/DaemonClient.ts`                      | new client method                                                                                                                 |
| `packages/sdk-typescript/src/index.ts`, `src/daemon/index.ts`             | type re-exports                                                                                                                   |
| `packages/web-shell/client/brandContext.ts`                               | new: context, provider, hooks, built-in name, stable empty value                                                                  |
| `packages/web-shell/client/daemon/workspace/types.ts`                     | optional brand and settled-flag fields on the workspace context                                                                   |
| `packages/web-shell/client/daemon/workspace/DaemonWorkspaceProvider.tsx`  | fetch once per connection with a settled flag, one bounded retry for transient failures, outside the status machine               |
| `packages/web-shell/client/App.tsx`                                       | brand and callback props, precedence resolution, provider mount                                                                   |
| `packages/web-shell/client/index.tsx`                                     | export the brand prop type                                                                                                        |
| `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx`        | name, version tooltip, logo with a falsy-node fallback and an image-decode fallback                                               |
| `packages/web-shell/client/components/sidebar/WebShellSidebar.module.css` | size the `img` logo like the inline `svg` one                                                                                     |
| `packages/web-shell/client/components/WelcomeHeader.tsx`                  | name                                                                                                                              |
| `packages/web-shell/client/components/messages/StatusMessage.tsx`         | About row label                                                                                                                   |
| `packages/web-shell/client/i18n.tsx`                                      | drop the orphaned About label key from both tables                                                                                |
| `packages/web-shell/client/index.html`                                    | pre-paint title and favicon from cache; boot watchdog excludes the icon from its fatal-resource classification and its error list |
| `packages/web-shell/client/main.tsx`                                      | apply title and favicon, write and clear the cache                                                                                |
| `packages/web-shell/client/e2e/utils/mockDaemon.ts`                       | answer the new route                                                                                                              |
| `packages/web-shell/README.md`, `docs/users/configuration/settings.md`    | document both channels                                                                                                            |

## Testing

The resolver gets the bulk of the unit coverage, because it is the part that
touches the filesystem: layer precedence in both directions, workspace-layer
exclusion for the name and the logo, placeholder rejection from the
pre-substitution snapshot (with a literal higher layer still overriding a
placeholder below), name sanitization and the length cap, tilde expansion,
relative resolution against the declaring file and the soft-fail when there
is none, missing file, symlink, directory, a FIFO swapped in past the
pre-open guards, oversize content in both the pre-read and post-decode caps,
the fd identity re-check and both fs soft-fail branches, non-SVG content, an
`xmlns`-less root, an `xmlns`-shaped substring hidden in another attribute's
value (immediately after the quote, and whitespace-prefixed inside the
value — the shape that pins the blanking), a prefix-only namespace binding, a
prefix-bound `<svg:svg>` root accepted with its binding and refused without
it, an `<svgfoo>` near-miss refused, an astral character before the xmlns,
whitespace around the attribute `=`, a quoted `>` or bracket inside DOCTYPE
literals and the root tag, and the scaling-geometry advisory for a root with
no usable geometry — absent, empty, zero or percentage. One case asserts
that an SVG containing script is _accepted_ — the resolver is meant to pass
bytes through. The alarm for a renderer that inlines those bytes lives on
the other side of the package boundary, in the sidebar test: it renders a
script-bearing logo and asserts the payload reaches the document only as an
`img` `src` with zero script nodes present. A future change that inlines the
logo fails that test, not the resolver's.

The route test asserts the response shape, that `skipWorkspaceSettings` is
passed, that a rejected logo still answers 200 with the name and reports the
reason on stderr, and that a settings failure degrades to an empty brand rather
than erroring. The schema test asserts both leaves and that neither reaches the
settings dialog; the settings route test asserts the keys are neither exposed
nor writable through it.

On the client, the provider test asserts the brand and the settled flag reach
the context on success, that a definitive 404 settles with no brand while a
retryable 503 stays unsettled (unknown, not absent), that a retryable failure
retries once on its own and is attributed on the console only once the retry
is exhausted, that `refreshBrand` re-issues the fetch with the same settle
rule and is a no-op on an already-resolved, settled, or in-flight brand, that
a superseded client can neither write its brand into nor settle the new
connection nor be re-asked by a refresh (per-instance call attribution), that
a token rotation re-fetches against the new identity, and that no committed
frame carries the previous client's brand beside the new connection's
baseUrl. The app test asserts prop-wins-over-fetched precedence (including
against a daemon brand that carries a logo — the takeover is whole-object,
not field-merge), in-flight silence for both an absent and a nullish host
prop, the unsettled-to-settled transition that production actually takes,
settled-with-no-brand reporting (which is what clears stale chrome), the
recovery path re-asking the brand alongside capabilities, host-prop
withdrawal reporting the empty brand again, empty-name normalization in the
payload, logo-URI pass-through, and no re-firing for a fresh-but-equal inline
prop and handler. The sidebar
test asserts the built-in rendering is untouched — the inline mark is asserted
present, not merely no image asserted absent — the name and tooltip follow the
brand, the logo renders as an image with no script node in the document, an
undecodable logo falls back to the built-in mark on `error` with a
`console.warn` (the one logo failure the daemon cannot see), a replacement
URI after such a failure gets a fresh mount, a falsy host logo falls back
too, a host logo node renders as given and never beside the built-in mark,
and the existing branding render override still wins. A server-level test
asserts the route answers JSON on the real app for a browser-like `Accept`
with the SPA fallback mounted, that it sits behind bearer authentication when
a token is configured, that the read-tier limiter can 429 it, and that a
draining daemon does not reject it; the System settings layer is pinned to
empty files there so a maintainer's machine-wide brand cannot leak into the
assertions, and the ordering test's body carries a fixture brand so the
response cannot be confused with the route's error fallback. The boot
watchdog test asserts a failing favicon neither proves boot impossible nor
enters the panel's error list past the grace timer. The standalone entry test
asserts the title, the favicon (untouched for a name-only brand), the cache
write, and clearing the cache when the brand goes away, plus that the built-in
title is derived to match the document's own static title, and — by reading
the entry the entry-point actually wrote, located by enumeration rather than
by a second copy of the key — that the real pre-paint script applies both
fields back. The pre-paint script joins the existing `index.html` contract
test, which also pins the built-in title and favicon bytes. A parity test runs
the same inputs through the TUI banner resolver and asserts identical
sanitization.

One property matters more than the others: with no brand configured, the
rendered shell is unchanged. That is what makes this safe to ship, and it is
what keeps the existing Playwright visual baselines valid instead of requiring
a re-capture.

## Decisions settled during implementation

A long brand name is limited in both places. The resolver clamps to 80
characters to match the TUI banner title, and the sidebar brand row already
carried `overflow: hidden` with `text-overflow: ellipsis`, so a name at the cap
still degrades gracefully in a narrow sidebar. No new layout rule was needed.

The resolved brand is not cached on the daemon. It is read from settings on
each request and the file read is bounded at 32 KiB, so caching would buy
nothing and add an invalidation question — the daemon has no settings watcher
to invalidate it with.

The brand prop replaces the fetched brand wholesale rather than merging field
by field. That matches how the theme and language props already behave, and a
host that passes `brand` is deliberately taking control of branding.
