# Serve pairing QR escape hatch and degraded address-only QR

[English](2026-09-19-serve-pairing-qr-escape-hatch.md) | [简体中文](2026-09-19-serve-pairing-qr-escape-hatch.zh-CN.md)

## Problem statement

Since #11172, `qwen serve` on a non-loopback bind prints a pairing QR at
startup that encodes `<lan-url>/#token=<bearer>` — QR delivery decoupled from
Local Control. The QR is withheld when the bearer is a **stable
operator-supplied token** and stdout is **not an interactive terminal**:

```ts
if (!input.generated && !process.stdout.isTTY) return;
```

The guard upholds a real invariant — an operator-configured long-lived
credential must never be republished into captured stdout (journald, container
logs, log aggregation) on every restart, because logs usually live in a wider
access-control domain than the secret's configured storage.

But the guard's current shape has three defects:

1. **Silent suppression.** Nothing is printed when the QR is withheld. The
   operator cannot discover why, short of reading the source.
2. **No escape hatch.** `isTTY` cannot distinguish "operator tails the log
   from an SSH terminal and would scan the QR off the screen" (safe) from
   "stdout is shipped to ELK" (leak). The daemon cannot see the deciding
   variable; the operator can — yet has no flag to express it.
3. **Over-broad penalty.** The guard suppresses the QR _mechanism_ together
   with the _secret_. An address-only QR carries zero marginal disclosure —
   the same addresses are already printed as plain text lines — and the Web
   Shell's `StandaloneAuth` gate already asks for the token when the URL
   carries none.

## Current state

`printRemoteQuickstart` (`packages/cli/src/serve/remote-quickstart.ts`) prints,
on a non-loopback bind: address lines, the generated-token line (ephemeral
tokens only), a plaintext warning when not TLS, then the QR block. The QR
block requires the Web Shell (`web`), picks one dialable private-LAN candidate
(preferring routable over link-local), falls back to a "QR unavailable" line
when no candidate exists, and then applies the suppression guard above.

## Proposed changes

All changes are confined to the startup quickstart block; Local Control, the
auth model, and the Web Shell are untouched.

### 1. `--pairing-qr` escape hatch

New boolean flag on `qwen serve` (no default — omission is distinguished from
`--no-pairing-qr`), plus a settings.json source `serve.pairingQr` (same
precedence pattern as `serve.channels`: the `serve` object in
`settingsSchema.ts`). When enabled, the token-bearing QR is printed even in the
suppressed case (stable operator token + non-interactive stdout). The operator
thereby declares: _my log pipeline is as trusted as the daemon host._ An
explicit flag of either polarity wins; the setting applies only when the flag
is omitted. Default behavior is unchanged.

Plumbing: `ServeArgs['pairing-qr']` → `ServeOptions.pairingQr`, and
`serve.pairingQr` via the serve fast-path settings summary
(`fast-path-settings.ts`); the flag takes precedence at the single
`printRemoteQuickstart` call site in `run-qwen-serve.ts`. Resolving the
settings source there — not in the yargs command layer — keeps the serve fast
path (which never runs the yargs handler) identical in behavior.

### 2. Suppression hint line

When the token-bearing QR is suppressed, print one line naming the reason and
the remedy:

```text
Token-bearing QR suppressed: stable operator token with non-interactive stdout. Pass --pairing-qr to print it anyway.
```

### 3. Degraded address-only QR

In the suppressed case, still print a QR encoding the bare candidate URL (no
`#token=` fragment), labeled so the operator knows the phone will be asked for
the token:

```text
Scan to open Web Shell: <url> (<label>)
Address-only QR: the Web Shell will ask for the bearer token.
<QR>
```

The address-only QR is printed through the same candidate selection and the
same best-effort `qrcode-terminal` path as today; it simply encodes less.

## Key design decisions

| Decision                                                                           | Rationale                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Default suppression stays                                                          | Secure-by-default: managed environments (k8s/systemd with shipped logs) are the case the guard protects; only the operator knows their log domain, so the override must be explicit                                                                                                                                |
| Opt-in via flag and `serve.pairingQr` setting                                      | Consistent with neighboring serve flags and the existing `serve.*` settings section (`serve.channels`); a persistent deployment (systemd unit, start script) can set it once in settings.json                                                                                                                      |
| Explicit flag of either polarity wins over the setting                             | `--no-pairing-qr` must be able to veto a settings-enabled credential print for one run — an explicit choice on the command line is the strongest operator signal, and a flag the setting always overrides is a dead switch on a credential guard                                                                   |
| `serve.pairingQr` honored from user/system/system-defaults scopes only             | A workspace settings file (`.qwen/settings.json` in a cloned repo) must not be able to push the operator's stable bearer into captured stdout; `readSettingsSummary` picks the key only for the operator-owned file reads, so the workspace file never carries it — the exclusion is structural, not a trust check |
| Address-only QR in the suppressed case                                             | Zero marginal disclosure (addresses already print as text) and the `StandaloneAuth` gate already handles token entry; removes the "type the address on a phone" friction without weakening the invariant                                                                                                           |
| Hint names `--pairing-qr` verbatim                                                 | Silent suppression was the discoverability bug; the remedy must be copy-pasteable from the log itself                                                                                                                                                                                                              |
| No hint when no dialable candidate exists                                          | The existing "QR unavailable" fallback already explains that case; a `--pairing-qr` hint would be irrelevant there                                                                                                                                                                                                 |
| Token-bearing QR text unchanged (`SECRET QR: grants daemon access. Do not share.`) | Existing warning stays accurate; the forced path is the same credential in the same fragment                                                                                                                                                                                                                       |

## Files affected

| File                                                         | Change                                                                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/commands/serve.ts`                         | `ServeArgs['pairing-qr']`, builder option, `serveOptions` mapping                                                                              |
| `packages/cli/src/config/settingsSchema.ts`                  | `serve.pairingQr` boolean property                                                                                                             |
| `packages/cli/src/serve/types.ts`                            | `ServeOptions.pairingQr?: boolean` with doc comment                                                                                            |
| `packages/cli/src/serve/fast-path.ts`                        | `pairing-qr` boolean flag → `ServeOptions.pairingQr`                                                                                           |
| `packages/cli/src/serve/fast-path-settings.ts`               | pick `serve.pairingQr` from operator-owned settings files only; merge it                                                                       |
| `packages/cli/src/serve/run-qwen-serve.ts`                   | resolve `opts.pairingQr` over `bootSettings.serve.pairingQr` into `printRemoteQuickstart`; name the field in the settings-read-failure warning |
| `packages/cli/src/serve/remote-quickstart.ts`                | suppression branch: hint + address-only QR; `pairingQr` bypass                                                                                 |
| `packages/cli/src/serve/remote-quickstart.test.ts`           | update the suppression test; add hint/address-QR/forced-QR tests                                                                               |
| `packages/cli/src/serve/fast-path.test.ts`                   | flag enumeration entry; settings-scope and precedence tests                                                                                    |
| `packages/cli/src/serve/run-qwen-serve.test.ts`              | opts/boot-settings resolution test incl. the explicit-false veto                                                                               |
| `packages/cli/src/commands/serve.test.ts`                    | flag mapping + `--no-pairing-qr` + default-absent tests                                                                                        |
| `docs/users/qwen-serve.md`                                   | flag table row + QR paragraph update                                                                                                           |
| `packages/vscode-ide-companion/schemas/settings.schema.json` | generated mirror of the schema addition (regenerated by the build)                                                                             |

## Scope boundaries

- No change to generated-token or interactive-TTY paths (full token QR still
  prints there).
- No change to `token-only`/`silent` loopback modes.
- No change to Local Control, its listener model, or its pairing token.
- No Web Shell changes; `StandaloneAuth` token entry is used as-is.
- No retry/persistence of the QR; it remains a one-shot startup block.

## Validation plan

Unit tests in `remote-quickstart.test.ts` cover: suppression hint text,
address-only QR payload (must not contain the token in raw or encoded form),
`--pairing-qr` forcing the token-bearing QR, and unchanged behavior for
generated-token/TTY/no-web/no-candidate paths. E2E plan:
`.qwen/e2e-tests/serve-pairing-qr.md` — baseline against the globally
installed CLI, then the same matrix against `node dist/cli.js`.

## Acceptance criteria

1. Stable token + redirected stdout prints the hint line and an address-only
   QR; no line contains the token in raw or URL-encoded form.
2. `--pairing-qr` with a stable token and redirected stdout prints the
   token-bearing QR with the existing SECRET warning.
3. Generated token, interactive TTY, `--no-web`, and no-candidate outputs are
   byte-identical to before.
4. `qwen serve --help` lists `--pairing-qr`.

## Open questions

None.
