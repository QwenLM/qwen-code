# Configurable session live-state polling interval

## Problem

Web Shell polls each selected workspace every two seconds. Five workspaces therefore produce about 150 recurring requests per minute. The default should be five seconds, with an operator configuration through the daemon environment rather than a Web Shell preference.

## Design

Read `QWEN_SESSION_LIVE_STATE_POLL_INTERVAL_MS` from the daemon startup environment. Accept integer milliseconds from 1000 through 2147483647; missing, blank, malformed, fractional, or out-of-range values use 5000. The lower bound prevents accidental subsecond polling and the upper bound avoids JavaScript timer overflow. Changing the environment takes effect after restarting the daemon and reloading any open Web Shell pages to refresh cached capabilities.

The existing process-global `GET /capabilities` route advertises the resolved numeric `sessionLiveStatePollIntervalMs`. Resolve it once from the injected, frozen daemon environment, never from a selected workspace overlay or ambient environment during a request. Keep the field optional in daemon and SDK types for compatibility with older daemons. No new feature tag or route is required.

The sidebar, session overview, and sidebarless App pass the already-loaded workspace capabilities value to the live-state hook. They use the same daemon-wide interval even when displaying several workspaces. The hook validates incoming values too, defaulting to five seconds for older or malformed capability responses. Direct SDK consumers can read the hint but continue to own their scheduling.

Changing the interval replaces only the recurring timer. In-flight reads, retained snapshots, catalog reconciliation, immediate local/visibility refreshes, and error backoff retain existing ownership and behavior. No Web Shell settings control, localStorage preference, or settings.json entry is introduced.

## Affected areas and validation

- Daemon capabilities route, envelope type, SDK type, protocol and user documentation.
- Three Web Shell call sites and the live-state hook/interval validation.
- Focused route tests for defaults, bounds, configured values and startup environment snapshotting.
- Hook and caller tests for actual scheduling, capability wiring, compatibility and cleanup.
- Browser tests and isolated global/local daemon runs for the default five-second cadence, a ten-second environment override, and compatibility with older daemons.

## Scope

No SSE, adaptive polling, per-workspace configuration, additional capability requests, or changes to full-catalog polling. Browser and other SDK consumers still own their polling timers.
