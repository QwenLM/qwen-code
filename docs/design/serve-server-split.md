# serve server.ts staged split

## Goal

Split `packages/cli/src/serve/server.ts` in stages without changing daemon behavior. The first stage extracts shared helpers and route groups whose boundaries are already clear, while keeping `createServeApp()` responsible for wiring middleware, stateful dependencies, transport mounts, and final error handling.

## Middleware And Route Order

The app assembly order is part of the public behavior and must stay stable:

1. same-origin `Origin` stripping
2. CORS and host allowlist
3. pre-auth `/health` and `/demo` on allowed loopback setups
4. access logging
5. Web Shell static assets
6. bearer auth
7. rate limit
8. JSON body parser and JSON parser error mapper
9. post-auth `/health` and `/demo` when required
10. daemon telemetry
11. REST route groups
12. ACP HTTP and WebSocket routes
13. Web Shell fallback
14. final error handler

## Extracted Boundaries

`server/request-helpers.ts` owns request-body sanitization, client-id parsing, loopback detection, path/query validators, and permission vote body parsing. Route modules depend on this file instead of importing from `server.ts`.

`server/error-response.ts` owns bridge error taxonomy and HTTP response mapping. The exported wrappers accept an optional daemon logger so route modules can keep the existing stderr and daemon-log behavior.

`server/session-list.ts` owns the persisted-plus-live session list merge used by both REST and ACP HTTP callers.

`server/fs-factory.ts` owns default workspace filesystem factory construction and fs audit warning emission.

`server/telemetry.ts` owns route classification and daemon HTTP telemetry middleware.

`server/prompt-deadline.ts` owns prompt deadline resolution and its abort sentinel class.

Route modules follow the existing `registerXRoutes(app, deps)` style. They receive only the dependencies they need, not a single god context.

## Non-goals

This stage does not change response bodies, status codes, headers, SSE frame format, authentication order, or error taxonomy. It does not delete compatibility re-export shims such as `status.ts`, `event-bus.ts`, or `in-memory-channel.ts`. It does not rename historical docs or cleanup unrelated camelCase paths.

`server.ts` may remain over 200 lines after this stage. The acceptance criterion is stable boundaries that make later session and SSE extraction mechanical.

## Audit Notes

Round 1 checked architecture boundaries and rejected a new Router abstraction because existing route modules already use direct `registerXRoutes(app, deps)` functions.

Round 2 checked failure paths and kept error taxonomy in one helper so route extraction cannot silently drift HTTP status codes.

Round 3 checked compatibility and keeps the public exports consumed by `run-qwen-serve.ts`, ACP HTTP dispatch, and tests.

Round 4 checked testing strategy and relies on focused `server.test.ts`, ACP HTTP, and route tests because this is structural refactoring with no user-visible behavior change.
