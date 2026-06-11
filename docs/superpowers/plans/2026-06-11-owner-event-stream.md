# Cycle 49 plan — owner event stream `GET /rc/events`

Fail-safe order: inert bus + route + AuditLog seam FIRST (all behavior-identical /
unmounted), server wiring + e2e LAST.

## Commit 1 (docs)

- spec + this plan.

## Commit 2 — bus + route + AuditLog seam (all inert)

- New `src/ownerEvents.ts`: `OwnerEvent = {type:'audit', record: AuditRecord}`,
  `OwnerEventBus` (Set of handlers; `subscribe` -> unsubscribe | null at cap;
  `publish` synchronous per-handler try/catch; `size` getter;
  `MAX_OWNER_SUBSCRIBERS=32`).
- New `src/routes/ownerEvents.ts`: `createOwnerEventsRoute(bus)` -> RequestHandler.
  subscribe BEFORE writeHead (cap -> 503 too_many_streams); writeHead 200
  event-stream + `: ok`; per-subscriber `dropping`/`dropped` + `res.write()===false`
  -> wait for `'drain'` -> `event: resync`; 25s unref'd heartbeat; `req.on('close')`
  -> clearInterval + unsubscribe + res.end.
- `src/auditLog.ts`: ctor `opts.onRecord?(record)`; in `doRecord` capture `ts`
  once, append, then `try { onRecord(record) } catch {}` after success.
- Tests: `ownerEvents.test.ts` (fan-out, unsubscribe, throwing-handler isolation,
  cap->null, size); `routes/ownerEvents.test.ts` (SSE connect + receive a published
  frame via fetch reader w/ timeout; OWNER gate 403; cap->503); `auditLog` seam
  test (record -> onRecord fires once with {ts,...entry} after append).

## Commit 3 — server wiring + e2e (LAST)

- `src/server.ts`: `const ownerEvents = new OwnerEventBus()` before the AuditLog;
  `new AuditLog(path, undefined, { onRecord: (r) => ownerEvents.publish({type:'audit', record:r}) })`;
  mount `app.get('/rc/events', requireScope(OWNER, audit), createOwnerEventsRoute(ownerEvents))`
  near the other OWNER routes. Bus stays internal (not returned).
- `scripts/rc-gateway-e2e.mjs`: OWNER token opens `/rc/events`; trigger an audited
  action (mint a token); assert a `data:` frame arrives within a timeout
  (AbortController-bounded so it can never hang); non-owner -> 403.

## Verify

- typecheck / lint / build / test (expect +~12 vitest)
- e2e (expect 41 -> ~43)
- opus review on `git diff <base>..HEAD -- packages/rc-gateway/`.
