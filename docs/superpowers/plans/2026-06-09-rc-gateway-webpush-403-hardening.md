# Plan — rc-gateway webpush 403/401 send-failure hardening (cycle 24)

Design: `docs/superpowers/specs/2026-06-09-rc-gateway-webpush-403-hardening-design.md`.

**Branch:** `add-remote-control-spec` — stay on it. Run all git/npm from repo
root `/home/evan/projects/qwen-code` with absolute paths. No `--no-verify`.
Commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

Small, localized change to `sender.ts` status branching, fully covered by the
existing fake-transport unit tests. Done directly (no implementer subagent);
the opus review + the new red-against-old tests are the gates.

## Step 1 — tests first (red against current 403-removes behavior)

`src/webpush/sender.test.ts`, add inside `describe('PushSender')`:

- `403 → keep subscription + push_send_failed{reason:'auth_error',statusCode:403}, single transport call`:
  transport returns 403; assert `calls === 1` (NO retry), `store.get(record.id)`
  is still defined (KEPT), exactly one `push_send_failed` whose detail
  `toMatchObject({subscriptionId, statusCode:403, reason:'auth_error'})`, and
  NO `push_subscription_expired`. (This FAILS today: current code removes the
  sub and emits push_subscription_expired.)
- `401 → same as 403` (auth error, kept, no retry, reason:'auth_error').
- Extend the existing `persistent 503` test (or add an assertion) so the
  `push_send_failed` detail `toMatchObject({reason:'transient_exhausted', statusCode:503})`.

Keep the `410 → remove` test as-is (proves the Gone path is unchanged).

## Step 2 — implement

`src/webpush/sender.ts`:

- Replace `isPermanent` with:
  ```ts
  function isGone(code: number): boolean {
    return code === 404 || code === 410;
  }
  function isAuthError(code: number): boolean {
    return code === 401 || code === 403;
  }
  ```
- In the attempt loop, after the `is2xx` early-return, branch:
  ```ts
  if (isGone(code)) {
    await this.store.remove(record.id);
    await this.safeAudit('push_subscription_expired', {
      subscriptionId: record.id,
      statusCode: code,
    });
    return;
  }
  if (isAuthError(code)) {
    // Auth/config error (e.g. VAPID misconfig) — identical across all subs.
    // Keep the sub (don't wipe the store on one misconfig); don't retry
    // (config won't change mid-loop). Fail fast.
    await this.safeAudit('push_send_failed', {
      subscriptionId: record.id,
      kind: payload.kind,
      statusCode: code,
      reason: 'auth_error',
    });
    return;
  }
  // Transient (429 / 5xx / 0): retry per backoff.
  if (attempt < MAX_ATTEMPTS - 1) {
    await this.sleep(this.backoffMs[attempt] ?? 0);
  }
  ```
- After the loop, the transient-exhausted audit gains `reason: 'transient_exhausted'`:
  ```ts
  await this.safeAudit('push_send_failed', {
    subscriptionId: record.id,
    kind: payload.kind,
    statusCode: lastCode,
    reason: 'transient_exhausted',
  });
  ```
- Update the class doc comment block to describe the three branches.

No signature/type changes (`safeAudit` detail is already `Record<string,unknown>`).

## Step 3 — verification sweep (repo root)

```
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
npm run test --workspace @qwen-code/rc-gateway
node scripts/rc-gateway-e2e.mjs
```

e2e stays 39/39 (no route surface). Confirm
`git diff --name-only 8e0ff9946..HEAD` lists only
`packages/rc-gateway/src/webpush/sender.ts`, `…/sender.test.ts`, + the two docs.

## Commits

- docs: `docs(rc-gateway): cycle 24 spec+plan — webpush 403/401 send-failure hardening`
- impl: `fix(rc-gateway): keep subscription on 401/403 push auth error (no sub-store wipe on VAPID misconfig)`

Then opus review → fix → push → memory.
