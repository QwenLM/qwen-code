# serve server.ts final split

## Goal

Continue the staged `packages/cli/src/serve/server.ts` split without changing daemon behavior. This pass moves the remaining inline REST handlers, small middleware helpers, capability construction, device-flow registry setup, and rate-limiter setup into focused internal modules. `createServeApp()` remains the composition point for daemon state, middleware order, route registration, ACP transport mount, Web Shell fallback, and final error handling.

## Middleware And Route Order

The assembly order is part of the daemon contract and must stay visually auditable in `createServeApp()`:

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

`server/self-origin.ts`, `server/access-log.ts`, `server/rate-limiter-setup.ts`, and `server/error-handlers.ts` own small middleware/setup blocks that previously lived inline in `createServeApp()`. They are intentionally thin and keep the same registration order in `server.ts`.

`server/serve-features.ts` owns the language-code list, voice transcription capability cache, and advertised feature envelope input construction. Its cache invalidation function is still called by workspace settings reload/change paths.

`server/device-flow-registry.ts` owns default Qwen OAuth provider registration, event sink wiring, audit stderr breadcrumbs, and `app.locals` registry installation.

`routes/capabilities.ts` owns `GET /capabilities`.

`routes/workspace-mcp-control.ts` owns MCP restart/manage/runtime add/remove mutations.

`routes/workspace-lifecycle.ts` owns `/workspace/init` and `/workspace/reload`.

`routes/workspace-tools.ts` owns `/workspace/tools/:name/enable`.

Each route module receives only the dependencies it needs. None of the new modules import `server.ts`, which keeps dependency direction one-way and avoids cycles.

## Remaining In `server.ts`

`server.ts` still owns app creation, bound-workspace canonicalization, bridge/filesystem/workspace construction, mutation gate creation, route ordering, ACP HTTP/WebSocket mount, Web Shell static/fallback placement, and the compatibility exports consumed by existing callers.

The file is not required to drop below 200 lines in this PR. The acceptance criterion is that it has no inline REST endpoint handlers and reads as an assembly file whose behavioral ordering can be reviewed in one place.

## Non-goals

This pass does not change response bodies, status codes, headers, SSE frames, ACP behavior, auth gates, rate-limit tiers, device-flow semantics, or error taxonomy. It does not remove `status.ts`, `event-bus.ts`, or `in-memory-channel.ts` compatibility shims. It does not rename historical docs or introduce a Router framework or a single god context for routes.

## Audit Notes

Round 1 checked architecture boundaries and kept the existing `registerXRoutes(app, deps)` pattern instead of adding a Router abstraction.

Round 2 checked dependency direction and moved device-flow/runtime setup behind helpers without letting any route module import `server.ts`.

Round 3 checked failure paths and kept bridge error mapping, JSON body parser errors, strict mutation gates, and client-id validation call sites behavior-preserving.

Round 4 checked compatibility and retained public exports from `server.ts` for `run-qwen-serve.ts`, ACP HTTP callers, and tests.

Round 5 checked testing strategy and uses focused `server.test.ts`, route tests, ACP HTTP tests, typecheck, build, lint, inline endpoint grep, and `git diff --check`.
