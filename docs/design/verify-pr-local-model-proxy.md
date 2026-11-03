# Host-side model proxy for a containerised /verify-pr round

[English](verify-pr-local-model-proxy.md) | [简体中文](verify-pr-local-model-proxy.zh-CN.md)

Status: implemented.

## Problem

The local `/verify-pr` path must execute untrusted PR code inside a
credential-free boundary, and the skill's isolation gate says so. The recipe
stopped at that requirement: it had no way to let the round reach a model
without putting the real key inside the container, no container invocation,
and no host-side shape for the steps that must not run from the PR tree.

Three concrete failures followed:

- **The key had no safe path.** Exporting `OPENAI_API_KEY` inside the
  container either hands the real credential to PR code or trips the isolation
  gate, which refuses any non-empty `OPENAI_API_KEY` because it cannot tell a
  proxy token from a real key.
- **The proxy and the checker are host steps with host privileges.** A
  repo-relative `node scripts/...` executed from the round tree runs the PR's
  own copy, while the proxy holds the real key and the checker reads the
  artifact that certifies the round. The artifact directory is writable by the
  code the round just executed.
- **The obvious container invocation does not support the round.** An
  interactive `docker run -it` with no name cannot be driven by an agent;
  mounting only the tree leaves a linked worktree's absolute gitfile
  unreachable and produces root-owned files in the maintainer's checkout; and
  the four-key artifact `context.json` is not the full metadata snapshot the
  round reads.

## Proposal

A host-side relay plus a recipe that names its trust boundaries.

- `scripts/verify-pr-model-proxy.mjs` listens on a chosen host address (the
  Docker bridge for container clients), holds `REVIEW_OPENAI_API_KEY`, and
  relays only the exact `${basePath}/chat/completions` path. Clients present a
  per-run bearer token (`QWEN_VERIFY_PROXY_TOKEN`); the proxy swaps it for the
  real key upstream. A nonce-echoing health endpoint distinguishes the process
  from a squatter, and the local recipe compares that nonce before it uses
  the proxy. Hop-by-hop request headers — both the fixed set and any name a
  `Connection` header nominates — and the upstream `content-encoding` are
  stripped; undici has already decoded the body, so forwarding that header
  would make the client decompress it twice. The idle watchdog is per-chunk,
  matches the qwen client's own 240 s stream tolerance, stays quiet while the
  downstream is paused, and re-arms on drain; a disconnect before upstream
  headers aborts the fetch instead of paying for a completion nobody reads.
- The recipe uses two checkouts. `<trusted-clone>` supplies every script the
  round runs, including the prepare preflight, the credential scan, the
  isolation gate, the publish guard and the post-round checker; `<pr-clone>`
  is a standalone clone at the PR head that the container mounts and that
  prepare is given as its cwd. The clone's `.git` is PR-controlled after a
  round, so it is not reused, and host-side git commands disable fsmonitor,
  hooks and credential helpers and empty every locally defined
  clean/smudge/process filter, following `include.path` so a filter defined
  in an included worktree file is enumerated too. A linked worktree is
  rejected by construction because its gitfile points outside the mount.
- The container is named and detached (`sleep infinity` plus `docker exec`)
  and runs with `--user "$(id -u):$(id -g)"` and `HOME=/tmp/qwen-home`, so
  files written into the mounted tree stay maintainer-owned; the CLI installs
  into the fresh home because there is no writable global prefix. The base
  commit's `.qwen` is mounted read-only over the tree, so the round's skill
  and project settings cannot come from the PR; the root `AGENTS.md`/`QWEN.md`
  are not covered and still come from the PR clone. The full snapshot is
  mounted from a host copy outside the tree, and the per-run proxy token is
  derived from the proxy's JSON file in the step that starts the container, so
  it stays out of shell history. The credential-free attestation is passed to
  the shell that starts the round, after `verify-pr-credential-scan.mjs`
  (trusted copy) rejects credential-shaped ignored files and
  credential-bearing git config — fetch, push and submodule URLs,
  `url.*.insteadOf` rewrites, and `Authorization`/`Proxy-Authorization`
  extraheaders — following `include.path` like prepare's filter
  enumeration, so a credential defined in an included worktree file is
  refused too; that scan lists ignored files one by one and leaves
  `node_modules`/`dist` alone, so a built tree is not refused. The round's
  engine is the released CLI unless the tree's own build is installed over
  it.
- The round reads `$QWEN_VERIFY_CONTEXT` from the full snapshot. After the
  round, the checker runs from `<trusted-clone>` with `--context <host copy>`,
  so a writable artifact `context.json` cannot pin its own expected head.

The CI lane keeps its inline proxy: that copy runs in a root-owned step on the
base-pinned workflow, and pointing it at the PR checkout would let a PR read
the real key.

## Alternatives considered

- **Export the real key into the container.** Rejected: the boundary exists to
  keep it out, and PR code can read its own environment.
- **Reuse the CI heredoc by extracting it and calling it from the workflow.**
  Rejected for the CI lane: the script would come from the PR checkout. The
  local script is therefore a deliberate second copy. It diverges in more than
  transport wiring: it matches the exact path instead of a suffix, strips
  `Connection`-nominated headers and `content-encoding`, uses a 240 s
  pause-aware idle window instead of the CI copy's fixed 120 s, and aborts a
  pre-header disconnect. A sync between the copies must carry those
  behavioural differences, not just the flags.
- **Print `0.0.0.0` or normalise the listen host to loopback.** Rejected: the
  printed value must be the address clients actually dial.
- **Mount the tree read-only.** Rejected as the only control: the round must
  build in the tree and write its artifacts there. The trust boundary is
  enforced by running the privileged host steps from `<trusted-clone>` and by
  pinning the expected head from a host-held snapshot.
- **Scan `credential.helper` commands for inline tokens.** Declined as out
  of the URL/header contract: a helper is a command, and spotting an inline
  token in one means parsing shell. Prepare's own git reads already disable
  `credential.helper`, and the recipe re-clones rather than reusing a
  PR-controlled `.git`; the residual shape is recorded here rather than
  silently dropped.

## Acceptance

- Proxies: bearer rejection, exact path allowlist, base-path prefixing,
  real-key injection, hop-by-hop stripping with a chunked body (fixed set and
  `Connection`-nominated names), a gzip upstream body with the header
  stripped, pre-header disconnect abort, paused-downstream survival,
  slow-but-healthy streams, upstream reset survival, IPv6 listen formatting,
  and the CLI's JSON coordinates.
- Credential scan: a nested ignored `.env`, `.env~`, `backup.env~`, `*.pem`,
  `*.key`, `*.p12`, `id_rsa*`, `credentials*`, `.git-credentials`, `.npmrc`,
  `.netrc` or `gha-creds-*.json` is refused (a `.pub` public key is not), as
  is any http(s) userinfo in `remote.*.url`, `remote.*.pushurl`,
  `submodule.*.url` or `url.*.insteadOf`, including a token used as the
  username (the bare `git@` account name carries no secret and stays benign
  in any spelling, like `ssh://git@`), and any `http.*.extraheader` value
  carrying an `Authorization` or `Proxy-Authorization` header (other header
  names stay clean); a credential arriving through `include.path` is
  refused on every enumerated key, and a credential-free include stays
  clean; installed `node_modules`/`dist` are ignored at any depth,
  including inside a workspace package, and a vendored git repository under
  them is excluded rather than refused; enumeration is path-limited so a
  large ignored dependency tree is never buffered; a nested project git
  repository is refused because git does not descend into it; a missing
  `--ignored` mode or a dropped pattern turns its test red.
- Host git hardening: prepare disables fsmonitor, hooks and credential
  helpers and empties every locally defined clean/smudge/process filter —
  following `include.path` — before reading the PR-controlled tree;
  planted-filter fixtures prove the override for a directly defined filter
  and for one arriving through an included worktree file, each with a
  positive control that fires without it; a non-git cwd is refused with the
  worktree message (exit 3), not an uncaught enumeration error.
- Checker: `--context` overrides the writable artifact copy, refuses an
  unusable snapshot instead of falling back (with a usable writable copy
  seeded), and keeps its existing exit codes.
- Recipe: every script names the trusted checkout (including prepare, the
  scan, the gate, the guard and the checker), the base commit's `.qwen` is
  mounted read-only, both credentials come from files rather than command
  lines (the key falls back to `REVIEW_OPENAI_KEY_FILE` when stdin is not a
  TTY, and is unset once the proxy owns it), the proxy's coordinates and
  nonce are awaited before the container starts, the token is re-derived in
  the `docker run` step, and the attestation is on the round's shell but not
  the `docker run` line; reverting any of those turns a recipe pin red.
- Mutation evidence: removing each of those guards turns its pin red.
- A real Docker smoke covers the gate passing with `QWEN_VERIFY_PROXY_TOKEN`,
  the gate refusing `OPENAI_API_KEY`, and a container request reaching a mock
  upstream with the real key injected.
