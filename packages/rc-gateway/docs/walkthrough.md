# Remote Control Walkthrough: From Zero to Multi-Device

This guide walks through setting up `rc-gateway` from a clean checkout and using
it to control a `qwen` session from a second device. It covers the golden
path — build, serve, pair, prompt — and the most common extensions: TLS,
browser CORS, chat bridges, policy, and notifications.

Commands below use `<port>` as a placeholder for whatever port the gateway
printed on startup, and `qwk_...` as a placeholder for a real token. Replace
both with the values you actually see.

## 1. Prerequisites

- Node.js 22 or later.
- A clone of the `qwen-code` monorepo.
- A project or workspace directory you want `qwen` to operate on (this is
  the directory the underlying `qwen serve` daemon will run against).

## 2. Build and Install

From the repository root:

```bash
npm install
npm run build --workspace @qwen-code/sdk
npm run build --workspace @qwen-code/rc-gateway
```

The SDK must be built first — `rc-gateway` depends on its compiled output.

## 3. Start the Gateway

From the repository root:

```bash
npx qwen-rc serve
```

Equivalently, once built:

```bash
node packages/rc-gateway/dist/cli.js serve
```

On startup, `qwen-rc serve`:

1. Spawns a `qwen serve` daemon bound to loopback only. This is the actual
   agent process; the gateway never exposes it directly.
2. Starts the gateway itself on a public-facing port, proxying and
   authenticating requests before they reach the daemon.
3. Generates a one-time pairing code and writes it to a file with `0600`
   permissions (owner read/write only). The file's path is printed to the
   console.
4. Prints its bind address (host and port) and current TLS status (on/off,
   and whether a certificate was found or issued).

Example startup output:

```
qwen-rc: daemon started on loopback (127.0.0.1:xxxxx)
qwen-rc: gateway listening on 0.0.0.0:<port> (tls: off)
qwen-rc: pairing code written to /home/you/.qwen/rc/owner-bootstrap.code (mode 0600)
```

Leave this process running for the rest of the walkthrough.

## 4. Pair Your First Client

Read the pairing code from the path printed above:

```bash
cat /home/you/.qwen/rc/owner-bootstrap.code
```

Redeem it against the gateway:

```bash
curl -X POST http://localhost:<port>/rc/pair/redeem \
  -H 'Content-Type: application/json' \
  -d '{"code": "<pairing-code>", "label": "my-laptop"}'
```

The response looks like:

```json
{
  "id": "tok_01h...",
  "token": "qwk_ab12cd34...",
  "scopes": ["owner"]
}
```

The `qwk_`-prefixed token carries owner scope — full control of the
gateway. **It is shown only once.** Save it somewhere safe (a password
manager or local secrets file); the gateway does not store it in retrievable
form and cannot show it to you again. If you lose it, pair again with a new
code or mint a new one from an already-authenticated client.

## 5. Use the Token

With `qwk_...` as your saved owner token:

List active sessions:

```bash
curl http://localhost:<port>/workspace/sessions \
  -H 'Authorization: Bearer qwk_...'
```

Get gateway capabilities (feature flags, supported bridges, limits):

```bash
curl http://localhost:<port>/capabilities \
  -H 'Authorization: Bearer qwk_...'
```

Attach to a session's live event stream (Server-Sent Events):

```bash
curl -N http://localhost:<port>/session/<id>/events \
  -H 'Authorization: Bearer qwk_...'
```

Send a prompt into that session:

```bash
curl -X POST http://localhost:<port>/session/<id>/prompt \
  -H 'Authorization: Bearer qwk_...' \
  -H 'Content-Type: application/json' \
  -d '{"content": "Hello from remote!"}'
```

Keep the `events` stream open in one terminal while sending prompts from
another to watch responses arrive in real time.

## 6. Enable TLS (Production)

Running with TLS is required before exposing the gateway beyond your own
loopback or a trusted LAN.

**Option A: ACME / Let's Encrypt (automatic).** Requires a real domain
name pointing at this host and port 443 reachable from the internet for the
HTTP-01 challenge. Point the gateway at your domain and it will provision
and renew the certificate automatically — no manual certificate handling.

**Option B: Manual certificate.** Supply your own certificate and key
files (for example, ones issued by an internal CA or a wildcard cert you
already manage) and point the gateway's TLS configuration at their paths.

Once TLS is active, the pairing output additionally includes the
certificate's TLS fingerprint, so a client operator can manually verify
they're connecting to the right host out of band (e.g. by comparing the
fingerprint over a phone call or a separate secure channel) before trusting
the connection.

## 7. Browser Access (CORS)

By default the gateway only admits requests from the daemon's own UI
origin, which is auto-admitted with no extra configuration — useful for a
local web UI served alongside the daemon.

For any other browser-based client (a separate web app on a different
origin), you have two options:

**Mint a pairing code that pre-admits the origin:**

Set `allowOrigin: true` (or supply the origin explicitly, depending on your
mint request) when generating the pairing code, and redemption from that
origin will register it automatically.

**Or admit an origin manually**, once you already hold a token:

```bash
curl -X POST http://localhost:<port>/rc/cors \
  -H 'Authorization: Bearer qwk_...' \
  -H 'Content-Type: application/json' \
  -d '{"origin": "https://your-app.example"}'
```

List currently admitted origins:

```bash
curl http://localhost:<port>/rc/cors \
  -H 'Authorization: Bearer qwk_...'
```

## 8. Set Up a Telegram Bridge

1. Create a bot via [@BotFather](https://t.me/BotFather) in Telegram and
   copy the bot token it gives you.
2. Mint a bridge-scoped pairing code from the gateway (narrower than owner
   scope — the bridge only needs to relay prompts and receive events) and
   redeem it to get a `qwk_...` token for the bridge.
3. Start the bridge sidecar:

```bash
npx qwen-rc-bridge telegram \
  --bot-token <telegram-bot-token> \
  --gateway http://localhost:<port> \
  --rc-token qwk_...
```

Once running, users who message the bot in Telegram can send prompts and
receive the agent's responses directly in the chat. The bridge identifies
each Telegram user to the gateway as a distinct sub-actor (for example,
`telegram:alice`), so audit logs and policy decisions can distinguish
between different people using the same bridge token.

## 9. Set Up a Discord Bridge

The flow mirrors Telegram:

1. Create a Discord application and bot in the
   [Discord Developer Portal](https://discord.com/developers/applications)
   and copy its bot token.
2. Mint a bridge-scoped pairing code and redeem it for a `qwk_...` token.
3. Start the bridge sidecar:

```bash
npx qwen-rc-bridge discord \
  --bot-token <discord-bot-token> \
  --gateway http://localhost:<port> \
  --rc-token qwk_...
```

As with Telegram, each Discord user is tracked as a sub-actor of the bridge
token.

## 10. Policy Engine

Policy rules let you auto-approve safe actions, require confirmation for
risky ones, and outright deny dangerous ones — without manually approving
every tool call from a remote client.

**Upgrading from an earlier version? Read this before you rely on an
existing policy file.** Rule matching was previously broken against real
permission frames, so `tool:` and `pathGlob:` rules never matched a real
call — they sat inert no matter what action they specified. This release
fixes matching, which means **`deny` rules begin blocking and `allow` rules
begin auto-approving for the first time** the moment you upgrade. Before you
trust an existing file, run
`qwen-rc policy lint <file>` — it reports how many `allow` rules are newly
effective and warns on any that were written against a tool name (e.g.
`write_file`) whose ACP kind also covers other tools (e.g. `edit`) it wasn't
written to cover. The gateway only ever sees a call's ACP kind, never its
tool name, so a rule naming one of those shared-kind tools cannot
distinguish it from the others remotely — `allow` on `write_file` also
allows `edit`.

Create `~/.qwen/rc/policy.yaml` (per-user; applies across every workspace
unless overridden below):

```yaml
defaults:
  action: prompt
rules:
  # `tool` is the ACP kind: read | search | edit | execute | fetch | other.
  # A known tool name (e.g. run_shell_command) is accepted and mapped to its
  # kind — note that mapping is lossy: write_file and edit share `edit`.
  - id: allow-reads
    match: { tool: read }
    action: allow

  # pathGlob matches every path the call touches, INCLUDING paths a shell
  # command reads or writes, so this also blocks `cat .env`. `priority: 10`
  # is REQUIRED here: `tool` alone scores 100 in the specificity ordering,
  # higher than pathGlob's 30, so without an explicit priority this rule
  # would lose to allow-reads above and a `read_file` on `.env` would be
  # auto-approved instead of denied (see "Rule ordering and the precedence
  # trap" below).
  - id: deny-dotenv
    match: { pathGlob: ['**/.env*'] }
    action: deny
    reason: secrets
    priority: 10

  # operation narrows to read | write | execute. Given the same priority,
  # for the same reason as deny-dotenv above.
  - id: deny-writes-to-config
    match: { pathGlob: ['**/config/**'], operation: write }
    action: deny
    priority: 10
```

This example auto-approves calls of kind `read` (e.g. `read_file`) —
except where a higher-priority deny also matches: `read_file` on `.env`
is denied by `deny-dotenv`, not auto-approved by `allow-reads`, because of
the explicit `priority: 10` above. (`grep_search` is kind `search`, a
different ACP kind from `read`, so `allow-reads` never applies to it
regardless of priority.) The two deny rules block any call that touches a
`.env*` file anywhere under the project root — including one reached
through a shell command such as `cat .env` — and any write anywhere under
`config/`. Anything no rule matches falls through to `defaults.action`,
`prompt` here, so the operator is asked.

`pathGlob` patterns are always anchored to the project root, regardless of
the tool call's own working directory, and an unrecognized `tool` value (not
a known kind or tool name) is a load error rather than a silent no-op. A
leading single `/` in a pattern (e.g. `/etc/**`) is still relative to the
project root (`<projectRoot>/etc/**`), NOT the filesystem root; a
filesystem-absolute pattern needs a doubled leading slash (`//etc/**`). A
deny written for a real absolute path using a single `/` silently never
fires — it matches a path under the project root that doesn't exist.

**Rule ordering and the precedence trap.** Rules are evaluated in
`(priority desc, specificity desc, index asc)` order, and the first
matching rule wins. Specificity is a fixed score per match field present on
a rule: `tool` scores 100 (or 90 for a tool glob like `read*`), while
`pathGlob` and `operation` each score only 30. That means a broad `tool:`
allow OUTRANKS a narrower `pathGlob`/`operation` deny by default, even
though the deny reads as more specific — exactly the trap `deny-dotenv` and
`deny-writes-to-config` above avoid by setting an explicit `priority`.
Whenever a `deny` must beat a broader `allow`, give the `deny` a higher
`priority` than the `allow`; do not rely on `pathGlob`/`operation` alone to
out-rank a `tool:` rule.

For a per-project override, create `<workspaceCwd>/.qwen/policy.yaml` in the
directory the `qwen serve` daemon is running against. Its rules are
prepended ahead of the user-scope rules, so a workspace rule wins any tie in
specificity against a user rule; its `defaults` block, if present, is
ignored — only the user-scope file controls the fallback action.

`originScope` and `sessionTag` are accepted by the schema but are never
populated by the running gateway, so a rule that matches on either of them
can never match.

Lint the file for syntax and rule-shape errors, and see the
newly-effective-rule advisories described above:

```bash
npx qwen-rc policy lint ~/.qwen/rc/policy.yaml
```

Dry-run the effective, layered policy against a single simulated call,
without a running gateway:

```bash
npx qwen-rc policy explain read --path=src/index.ts
```

Pass the ACP kind (e.g. `read`, `execute`) as the argument, plus any of
`--args=`, `--path=`, `--operation=read|write|execute` (repeatable or
comma-separated, e.g. `--operation=read,write`), `--scope=`, `--tag=`, or
`--project-root=` to shape the simulated call. `--project-root` overrides
the default `process.cwd()` anchor for both the simulated `pathGlob`
matching and the workspace policy-file layer — pass it when running
`explain` from somewhere other than the daemon's actual workspace, or the
reported verdict can diverge from real enforcement. The output lists each
rule in evaluation order as matched, skipped, or not-reached, followed by
the resulting decision.

The policy engine watches the file and hot-reloads it on change — no
gateway restart needed after editing rules.

## 11. Notification Routing

To receive push notifications about session activity (for example, when a
long-running task finishes while you're away), subscribe a browser push
endpoint:

```bash
curl -X POST http://localhost:<port>/rc/push/subscribe \
  -H 'Authorization: Bearer qwk_...' \
  -H 'Content-Type: application/json' \
  -d '{
    "endpoint": "https://push-service.example/abcd",
    "keys": { "p256dh": "<key>", "auth": "<key>" }
  }'
```

(The object above is a standard browser `PushSubscription`, typically
obtained from `pushManager.subscribe()` in your client code.)

Configure which events route to which channels in `routing.yaml`, for
example directing critical failures to push notifications and routine
completions to a bridge chat.

Quiet hours suppress non-critical notifications during a configured
window (e.g. overnight) so you aren't woken up by routine activity;
critical-kind notifications bypass quiet hours and are delivered
regardless.

## 12. Cross-Session Search

Search full text across every session's history:

```bash
npx qwen-rc search "error handling"
```

To restrict the search to a single fork tree (a session and everything
forked from it), use lineage filtering:

```bash
npx qwen-rc search "error handling" --lineage <sessionId>
```

## 13. Useful Commands

```bash
# Verify the audit log's integrity (detects tampering or gaps)
npx qwen-rc audit verify

# Discover other qwen-code daemons on the local network via mDNS
npx qwen-rc daemons discover

# Show currently active notification routing rules
npx qwen-rc routing rules

# Dry-run a routing rule against a sample event
npx qwen-rc routing test
```

## 14. Token Management

Additional clients don't need owner scope. Mint pairing codes with
reduced scopes (for example, read-only or session-specific access) for
each new device or bridge, so a compromised client token can only do what
it actually needs to.

To immediately invalidate every issued token (for example, after a
suspected leak), revoke everything at once:

```bash
curl -X POST http://localhost:<port>/rc/tokens/revoke-all \
  -H 'Authorization: Bearer qwk_...'
```

Every client will need to re-pair after a revoke-all.

Tokens have a 180-day maximum age, with sliding renewal on active use —
a token that's regularly used stays valid, while one that's dormant will
eventually expire and require re-pairing.
