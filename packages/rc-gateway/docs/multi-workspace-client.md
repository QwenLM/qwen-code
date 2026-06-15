# Multi-workspace client — gateway-side support

`add-multi-workspace-client` is mostly a **client** feature (a terminal/web client
that talks to several daemons and switches between them). Per the "build
gateway-side support only" decision, the gateway implements exactly one surface
the spec assigns to the daemon:

## `GET /ui/clients-manifest.json` (owner-scope)

Returns the operator's daemon registry `~/.qwen/rc/clients.toml` parsed to JSON so
the web client can render its daemon switcher without hand-copying URLs.

```jsonc
{
  "daemons": [
    {
      "name": "workstation-1",
      "url": "https://qwen.local:4170",
      "tokenStorageKey": "qwen-rc:qwen.local:4170:token",
      "default": true,
    },
  ],
  "generatedAt": "<ISO>",
}
```

Spec-faithful behavior (`routes/clientsManifest.ts`):

- The TOML file uses `[[daemon]]` (singular) array-of-tables; the JSON key is
  `daemons` (plural). Entries pass through **verbatim** — `default` is NOT
  synthesized (the client interprets "no explicit default → first entry wins").
- `generatedAt` is **endpoint-generated** at cache-build time, not read from file.
- Missing or invalid TOML → `{ "daemons": [], "warning": "<reason>" }` with status
  **200** (never a 5xx). The handler self-catches.
- The response is cached server-side for **60 s**.

The spec's "identical across daemons that share the same operator home directory"
refers to the **`daemons` content** (all daemons read the same home-dir file, so
the array is identical); `generatedAt` is a per-response freshness stamp and is
expected to vary by wall-clock.

### Security

The route lives in the otherwise-unauthenticated `/ui/` static namespace, so it
carries **route-level** `bearerResolve` + `requireScope(OWNER)` and is registered
**before** the static `/ui` mount (the global bearer middleware runs after that
mount). Owner token → 200; `read`-scope → 403; no token → 401 (all covered by
`server.test.ts`). The manifest body (urls / tokenStorageKeys) is never logged.
TOML parsing uses `smol-toml` (a regular dependency, not feature-gated).

### Not implemented (client-side, out of boundary)

The daemon registry file writer (`qwen rc daemons add`, atomic 0600 writes), the
web header daemon switcher + health-dot polling, per-daemon token storage, and the
"this daemon can serve arbitrary origins" trust warning are all client work. The
gateway only serves the manifest above.

**Per-daemon webpush labeling** is consciously skipped as client-side: a single
gateway never needs to know it is one-of-N subscriptions for a client — that
multiplicity is client-side orchestration across the daemons it has paired with.
