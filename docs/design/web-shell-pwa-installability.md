# Web Shell PWA installability

[English](web-shell-pwa-installability.md) | [简体中文](web-shell-pwa-installability.zh-CN.md)

## Problem and scope

Issue #11704 proposes an Android companion. The agreed first step is making the
existing daemon-served Web Shell installable. Today it has no web app manifest or
service worker. This change adds installation metadata and a connection-loss
page; it does not implement the Android shell, Web Push, background execution,
offline conversations, or a new transport.

## Design

- Link a manifest from the standalone HTML. Use a stable origin-root identity,
  scope and launch URL, with no token, session ID, query string or fragment.
  Reuse the existing Qwen application artwork at 192 and 512 pixels. Installation
  metadata uses the built-in Qwen Code identity; custom runtime branding remains
  a separate concern.
- Register a root-scoped service worker only in the production standalone entry,
  in a secure context and outside frames. Library consumers and the Vite
  development server do not register workers. Registration failure must not stop
  the existing UI from starting.
- The worker handles only GET document navigations to the root or an exact
  session deep link. It uses the network, preserves HTTP error responses, and
  returns a self-contained connection-loss page only when the network fails.
  Other routes, subresources, API calls, SSE and permission requests are left
  untouched. No Cache Storage, token storage or response persistence is added.
- Let worker updates follow the browser lifecycle. Do not force activation,
  reload active sessions, or take over existing pages immediately.
- Serve the two root PWA files publicly with revalidation and explicit content
  types. They contain no secrets. Extend the exact GET/HEAD allowlist used by the
  warm server, cold runtime gate and remote self-origin middleware together.
  Existing Host, CORS, authentication and CSP rules remain in force. Icons use
  the existing public assets route.
- Include the root files in the distributable CLI bundle as well as the Vite
  build. Installation must work from the artifact users actually run.

## Affected components

The standalone Web Shell entry, public assets and tests; daemon static serving
and its dependency-light pre-auth discriminator; bundle asset copying; user
documentation. The new routes are process-global public UI assets, not
workspace or session APIs. No SDK or protocol capability changes are needed.

## Constraints and risks

Installation and service workers require HTTPS or a loopback development origin.
Plain HTTP on a LAN IP continues to provide the normal Web Shell. Installation
does not copy credentials from a browser tab into another browser storage
context; the existing authentication flow may ask for a token again. A running
daemon and connection are still required for work. No background notification
promise is made. Device-specific credential revocation and the broader browser
support matrix remain prerequisites for the later Android shell.

## Validation and acceptance

Verify manifest identity and icon dimensions; worker registration on the built
standalone page; root/session offline navigation and recovery; no worker caches;
untouched API error responses and streams; GET/HEAD static routes with MIME and
cache headers before authentication; rejection of nearby paths and mutating
methods; packaged assets; normal browser boot. Run focused tests, build,
typecheck and the required project checks, and report platform limitations.

## Open questions

None for this first step. Native notifications, branding-aware installation
metadata and the Android implementation belong to subsequent proposals.
