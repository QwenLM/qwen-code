# Plan — `X-Commands-Revision` ETag on `GET /rc/commands` (cycle 35)

See design: `../specs/2026-06-10-rc-gateway-commands-revision-etag-design.md`.

TDD, fail-safe commit order. All commands from repo root, absolute paths.

## Commit 1 — docs

`docs/superpowers/specs|plans/2026-06-10-rc-gateway-commands-revision-etag*`.

## Commit 2 — pure `ifNoneMatchSatisfied` helper (inert) + tests

`routes/commands.ts`: add and export

```ts
/**
 * True when an `If-None-Match` header value matches `revision`. Lean per D5:
 * split on `,`, trim, strip an optional `W/` weak prefix and surrounding
 * double-quotes, compare to the hex revision. `*` is intentionally NOT honored.
 */
export function ifNoneMatchSatisfied(
  header: string | string[] | undefined,
  revision: string,
): boolean { ... }
```

Tests (new `commands.revision.test.ts` or append to route test): undefined→false;
exact `hex`→true; quoted `"hex"`→true; weak `W/"hex"`→true; mismatch→false;
comma list containing the value→true; empty string→false; array header joined→true.

Verify: `npx vitest run --root packages/rc-gateway src/commands/...`.

## Commit 3 — wire into the handler + barrel + round-trip route tests

`createListCommandsRoute`: after building `commands`, build
`const body = { v: 1, commands };`,
`const revision = createHash('sha256').update(JSON.stringify(body)).digest('hex');`,
`res.set('X-Commands-Revision', revision);`, then
`if (ifNoneMatchSatisfied(req.headers['if-none-match'], revision)) { res.status(304).end(); return; }`,
else `res.status(200).json(body);`.

`index.ts`: export `ifNoneMatchSatisfied`.

Route tests (the spec scenario as a real round-trip, per advisor):

- 200 carries an `X-Commands-Revision` header (non-empty hex).
- Round-trip: GET → read actual revision → GET with `If-None-Match: <rev>` →
  304, empty body (`await res.text() === ''`), header echoed on the 304.
- Quoted form: `If-None-Match: "<rev>"` → 304.
- Negative: modify a command file between GETs → 200 + a _different_ revision.
- Scope-fold: a SESSION*READ-only caller and a WRITE caller get \_different*
  revisions for the same registry (invocableByYou differs → body differs).

## Verify (repo root)

```
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
npm run test --workspace @qwen-code/rc-gateway
node scripts/rc-gateway-e2e.mjs
```

## Review → fix → push → memory

opus adversarial review on `git diff dec8a8392..HEAD -- packages/rc-gateway/`;
apply fixes; push to `origin/add-remote-control-spec`; update both memory files.
