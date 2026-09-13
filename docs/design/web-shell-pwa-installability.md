# Web Shell PWA Installability and Browser Compatibility

[English](web-shell-pwa-installability.md) | [简体中文](web-shell-pwa-installability.zh-CN.md)

Status: implemented and verified locally (Sep 2026). Source: maintainer
direction in QwenLM/qwen-code issue #11704.

## Problem

The Web Shell is not installable as an app (no PWA manifest, no service
worker) and declares no browser support floor. A thin Android shell (see
`mobile-android-shell.md`) embeds the same H5 on Android System WebView
engines we do not control, where a stale engine fails as a white screen (JS
syntax below Chrome 107) or as silently broken layout (`:has()` /
`@container` below Chrome 105, `100vh` with the Android URL bar).

## Current State

- No `browserslist`, no runtime engine detection, no "unsupported browser"
  screen anywhere in the package.
- `:has()` and `@container` are used in the mobile-critical components
  (sidebar session list, message timeline, workspace sections, manager
  panels) with no `@supports` fallbacks.
- 22 uses of `100vh`, zero of `dvh`; on Android `100vh` is the large
  viewport, so the composer sits under the URL bar. The `mobile-chromium`
  Playwright project cannot catch this (fixed viewport = false green).

## Goals

1. Make the Web Shell installable: manifest + service worker on the daemon
   origin, no new toolchain, pre-auth routes side-by-side with existing
   shell assets.
2. Declare a support matrix (`browserslist` + README) and make degradation
   explicit: `@supports` fallbacks for `:has()`/`@container`, `dvh` pairs,
   and a runtime engine floor screen.

## Out of Scope

- Offline work, Web Push delivery, notifications while the app is closed.
- A second UI of any kind; the native shell remains the only extra surface.
- Polyfilling missing CSS/JS features below the declared floor; engines below
  the floor get the explicit update screen instead.

## Proposed Solution

### PWA installability

- `public/manifest.webmanifest`: `start_url: "/"`, standalone display, PNG
  icons 192/512 plus the SVG mark, Qwen brand colors.
- `client/sw.js`: classic (non-module) script built by Vite as a second
  entry, emitted at the root as `sw.js` (no hash). Cache-first for
  `/assets/*` only; versioned by `qwen-code-shell-v1-<version>`; daemon API
  routes, SSE, non-GET and requests with an `Authorization` header are always
  network-only. No pre-caching, no offline app shell.
- Registration in `main.tsx` is deferred to the `load` event, scoped to the
  standalone entry (the embedded library does not register a worker).
- Daemon routes `GET /manifest.webmanifest` and `GET /sw.js` are mounted
  before `bearerAuth`, send `no-cache` (and `Service-Worker-Allowed: /` for
  the worker) and are mirrored in `isPreAuthWebShellRequest` so the cold
  daemon answers them too.

### Browser compatibility

- `browserslist` in `packages/web-shell/package.json`: Chrome/Edge 107+,
  Firefox 104+, Safari 16+ (matches Vite's baseline-widely-available), and a
  Browser Support Matrix section in the README.
- Wrap every `:has()` selector in
  `@supports (selector(:has(*)))` and every `@container` in
  `@supports (container-type: inline-size)` — 40 `:has()` uses across 7
  blocks and 23 `@container` uses across 12 blocks.
- Give every `100vh` declaration a `100dvh` fallback on the next line
  (15 pairs in 8 files, including the dialog shell).
- Add an ES5, dependency-free engine check to `client/index.html` that runs
  before the module graph: Chromium below 107 renders an explicit "update
  your browser / Android System WebView" screen.

## Design Decisions

- Serve the PWA from the daemon origin rather than bundling it locally; a
  locally bundled copy would make every API call cross-origin and force
  `--allow-origin` operator configuration.
- Cache only hashed `/assets/*`: content-addressed files cannot go stale, so
  cache-first is safe and the cache-name version key handles upgrades.
- Network-only for everything else keeps session state, SSE streams and
  bearer auth out of any cache, matching the daemon's trust model.
- Engine floor 107 is derived from Vite's baseline-widely-available, not
  chosen independently; `dvh` is polyfilled by the paired fallback, `:has()`
  and `@container` by `@supports` guards.
- `format: 'es'` for the worker entry: a single chunk without imports emits
  a plain classic script; Vite rejects `iife` with multiple inputs
  (`inlineDynamicImports`).

## Constraints

- The CSP already allows `worker-src 'self'`, so no policy change is needed.
- The daemon only serves `/assets/*` and the root; manifest and worker must
  live at those exact paths (`/manifest.webmanifest`, `/sw.js`).
- SW registration requires a secure context; plain-HTTP LAN deployments do
  not get the worker (documented; TLS is the primary path).

## Risks

- An SW cache-first bug would serve stale JS to every client; mitigated by
  hashed filenames, versioned cache names and eviction on activate.
- SVG-only install icons are ignored by Android Chrome; PNG 192/512 are
  shipped alongside the SVG.

## Validation

- Full monorepo `npm run build`; inspect `dist/sw.js` (version injected),
  `dist/manifest.webmanifest`, `dist/assets/icon-192.png`,
  `dist/assets/icon-512.png`.
- `npx vitest run src/serve/web-shell-static.test.ts` in `packages/cli`
  (pre-auth PWA routes); scan all client CSS for bare `:has()`/`@container`
  and `100vh` without a `dvh` pair (braces-balanced parser check).
- Screen check: install prompt appears on Chrome desktop/Android; stale
  WebView shows the update screen.

## Acceptance Criteria

1. All `:has()` and `@container` uses sit inside `@supports` blocks; every
   `100vh` has a `dvh` partner line.
2. `browserslist` and README matrix match Chrome/Edge 107+, Firefox 104+,
   Safari 16+.
3. `/manifest.webmanifest` and `/sw.js` answer pre-auth with `no-cache`.
4. The worker caches only `/assets/*`; daemon routes and authorized requests
   are never intercepted.
5. Chromium below 107 renders the update screen instead of a blank page.

## Follow-ups

- Web Push registration is stubbed in `sw.js` and currently references the
  shipped PNG icons; wire push delivery only when the daemon or the Android
  shell raises notifications natively.
- Re-verify installability on iOS (Safari needs explicit "Add to Home
  Screen"; the web manifest is only partially honored there).
