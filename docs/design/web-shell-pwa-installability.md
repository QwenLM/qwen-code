# Web Shell PWA Installability and Browser Compatibility

[English](web-shell-pwa-installability.md) | [简体中文](web-shell-pwa-installability.zh-CN.md)

Status: implementation under review. Follows the optional PWA direction in [issue #11704](https://github.com/QwenLM/qwen-code/issues/11704).

## Problem

The daemon-served Web Shell needs install metadata and an explicit browser support contract. An unsupported engine must show an update message instead of a blank page. Publishing the CLI must preserve the PWA files emitted by the Web Shell build.

## Goals

- Add same-origin install metadata and a service worker to the standalone shell.
- Declare a floor that covers both JavaScript and the generated CSS.
- Keep daemon state, tokens, event streams and HTML out of worker caches.

## Out of Scope

Offline sessions, Web Push delivery, notifications after closing the app, and polyfills for engines below the declared floor. The embedded component library does not register a service worker or install the standalone browser guard.

## Design

### Build and public routes

Vite emits the standalone UI to `packages/web-shell/dist`, including `index.html`, `manifest.webmanifest`, `sw.js` and `assets/`. The worker is a second entry with no imports or exports; although Rollup uses ES output, this entry remains usable as a classic worker. The bundle copier preserves both PWA files under `dist/web-shell`; the package release gate rejects missing files.

The daemon serves GET/HEAD requests for the manifest and worker before bearer authentication. These process-global assets carry no workspace data or credentials. The cold-daemon predicate mirrors Express's case-insensitive paths and optional trailing slash. Manifest responses use `application/manifest+json`; worker responses use `application/javascript` and `Service-Worker-Allowed: /`. Both use `no-cache` and `nosniff`; missing files return 404 rather than shell HTML.

### Worker lifetime and caching

Only the production standalone entry registers `/sw.js` after page load. Registration failure leaves ordinary online use available. HTTPS or a trustworthy loopback origin is required; arbitrary plain-HTTP LAN origins do not support registration.

The worker activates immediately using `skipWaiting` and `clients.claim`. It removes older `qwen-code-shell-*` caches while preserving unrelated caches. The current namespace contains the package version; content-hashed chunk filenames distinguish builds made with the same version.

Only same-origin build assets are cache-first. Unhashed `icon.svg` and `icon-*.png` files bypass the worker cache and receive HTTP revalidation headers. The manifest also stays on the browser network path, so same-version deployments can update it. Non-GET, cross-origin, authorized and SSE requests are untouched. Ordinary API fetches are not intercepted. HTML navigation uses the network and returns a static 503 retry page on connection failure; it never restores cached session HTML. Cache reads or writes failing must not prevent an available network asset from loading.

### Browser contract and layout

The support floor is Chrome/Edge/Android System WebView 111+, Firefox 128+, and Safari/iOS 16.4+. This follows [Tailwind v4's CSS requirements](https://tailwindcss.com/docs/compatibility), not Vite's default target. The explicit JavaScript build target remains ES2021, including compatibility with xterm's generated syntax; a syntax target alone does not establish CSS support.

An ES5 inline guard checks known browser versions and, when available, required CSS capabilities before the module graph starts. It marks unsupported engines; the existing boot watchdog renders one themed update panel inside `#root`. Main boot preserves that panel. Unknown user agents may attempt to load, with the existing failure watchdog as a fallback.

The modified viewport rules retain `vh` fallbacks and add `dvh` where the actual rendered element needs it. Dialog sizing applies to the current Radix dialog content, including fullscreen. Tooltip viewport custom properties use an `@supports` guard because an unsupported unit inside a custom property invalidates the whole computed declaration. Existing `:has` and container guards are progressive CSS behavior, not polyfills or a promise to support older engines.

## Constraints and Risks

- A manifest does not guarantee an automatic install prompt: browser policy, engagement, secure context and platform UI still apply.
- Service worker activation affects open tabs immediately. Hashed assets retain their content identity; API state and HTML are never cached.
- Dynamic viewport units cover toolbar resizing, but do not establish that every mobile keyboard behaves identically.
- The browser matrix is a support contract, not a claim that every minimum engine or physical device was tested.

## Reviewer Test Plan

1. Start a token-protected daemon from the packaged CLI. Open the shell and retrieve the manifest, worker and icons without a bearer. API requests without a bearer must remain unauthorized.
2. Redeploy changed metadata at the same package version. Reload and check that the manifest and all public icons update; hashed chunks may remain cached.
3. Stop the daemon and navigate. Expect a readable retry page, without restored sessions or cached API responses. Reconnect and retry.
4. Simulate an unsupported browser version and a module-load failure independently. Expect one appropriate message inside the themed root, with no second message or blank page.
5. On supported mobile browsers, inspect normal/fullscreen dialogs and composer tooltips while changing viewport height.
6. Verify installation through the browser's available install/Add to Home Screen UI. Record the actual browser and device; an automated fixed viewport alone does not prove device installability.

## Validation Evidence

Targeted automated tests cover HTTP routes, packaging, worker behavior and parsed-document boot. The PR verification report records commands, results and exact revision. Physical-device installation, minimum-engine rendering and mobile keyboard behavior require separate device evidence; they are not claimed here.
