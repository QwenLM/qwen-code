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
  relays only `POST /chat/completions`. Clients present a per-run bearer token
  (`QWEN_VERIFY_PROXY_TOKEN`); the proxy swaps it for the real key upstream.
  A nonce-echoing health endpoint distinguishes the process from a squatter.
  Hop-by-hop request headers are stripped. The idle watchdog is per-chunk,
  matches the qwen client's own 240 s stream tolerance, stays quiet while the
  downstream is paused, and re-arms on drain; a disconnect before upstream
  headers aborts the fetch instead of paying for a completion nobody reads.
- The recipe uses two checkouts. `<trusted-clone>` runs the proxy and the
  post-round checker; `<pr-clone>` is a standalone clone at the PR head that
  the container mounts. A linked worktree is rejected by construction because
  its gitfile points outside the mount.
- The container is named and detached (`sleep infinity` plus `docker exec`),
  runs as the host uid with `HOME=/tmp/qwen-home`, mounts the full snapshot
  from a host copy outside the tree, and sets the credential-free attestation
  inside only after rejecting credential-shaped ignored files. The CLI
  installs into the fresh home, so nothing in the tree becomes root-owned.
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
  local script is therefore a deliberate second copy, and the divergence is
  limited to the listen flag, the JSON coordinates, and header stripping.
- **Print `0.0.0.0` or normalise the listen host to loopback.** Rejected: the
  printed value must be the address clients actually dial.
- **Mount the tree read-only.** Rejected as the only control: the round must
  build in the tree and write its artifacts there. The trust boundary is
  enforced by running the privileged host steps from `<trusted-clone>` and by
  pinning the expected head from a host-held snapshot.

## Acceptance

- Proxies: bearer rejection, path allowlist, base-path prefixing, real-key
  injection, hop-by-hop stripping with a chunked body, pre-header disconnect
  abort, paused-downstream survival, slow-but-healthy streams, upstream reset
  survival, IPv6 listen formatting, and the CLI's JSON coordinates.
- Checker: `--context` overrides the writable artifact copy, refuses an
  unusable snapshot instead of falling back, and keeps its existing exit
  codes.
- Mutation evidence: removing each of those guards turns its pin red.
- A real Docker smoke covers the gate passing with `QWEN_VERIFY_PROXY_TOKEN`,
  the gate refusing `OPENAI_API_KEY`, and a container request reaching a mock
  upstream with the real key injected.
