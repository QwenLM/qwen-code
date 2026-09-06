# ACP compile-cache propagation

## Context

The production `cli-entry.js` wrapper already enables Node's module compile cache for the in-process `serve` fast path. The daemon later spawns an ACP child through `createSpawnChannelFactory()`, but `module.enableCompileCache()` affects only the current process and does not populate `NODE_COMPILE_CACHE`. The ACP child therefore starts without the cache unless the operator set that environment variable before launching Qwen Code.

This is the orthogonal compile-cache candidate recorded on #7264. It does not shrink the eager module graph; it reuses V8 code cache for the graph that remains after the lazy-loading work.

## Goals

- Let production ACP descendants reuse the compile-cache directory already enabled by the daemon entry wrapper.
- Preserve an operator-provided `NODE_COMPILE_CACHE`.
- Preserve `NODE_DISABLE_COMPILE_CACHE=1`.
- Keep cache failures a quiet optimization failure rather than an application failure.
- Avoid changing the ACP bridge, configuration, or session lifecycle.

## Non-goals

- Do not introduce a Qwen-specific cache location, eviction policy, or cleanup command.
- Do not force compile-cache support on Node versions where the JavaScript API is unavailable.
- Do not flush the cache from the daemon or ACP lifecycle.
- Do not change test or coverage environments globally.

## Startup topology

The production daemon path is:

1. `cli-entry.js serve`
2. `module.enableCompileCache()` in the daemon process
3. in-process import of the bundled CLI
4. `createSpawnChannelFactory()` copies `process.env`
5. a new Node process reads `NODE_COMPILE_CACHE` during startup
6. the child runs the selected CLI entry with `--acp` (`cli.js` by default, or `QWEN_CLI_ENTRY` when explicitly configured)

Today step 2 benefits only the daemon. The environment copied at step 4 has no compile-cache directory, so the child at steps 5 and 6 does not opt in.

## Proposed change

Capture the result of the existing `module.enableCompileCache()` call. When it reports a newly enabled cache, exposes a directory, and the operator did not provide `NODE_COMPILE_CACHE`, publish that directory in `process.env`. Existing child-process construction already copies the environment, so no ACP-layer change is necessary.

Do not overwrite an existing environment value. When Node enabled the cache from a pre-existing environment variable it reports an already-enabled state and the original base directory must remain intact. Replacing it with `getCompileCacheDir()` or the already-enabled result can create a nested version directory in descendants.

Do not synthesize a directory when enabling fails, is disabled, or the API is unavailable. These cases retain the current behavior.

## Alternatives considered

### Set the environment variable in `spawnChannel`

Rejected. Compile-cache ownership is process-global entry behavior, while `spawnChannel` is shared ACP infrastructure used by embedded hosts. Moving policy there broadens the architectural surface and duplicates Node bootstrap behavior.

### Set a Qwen-versioned cache under `QWEN_HOME`

Rejected. Node already separates incompatible Node versions and keys entries by module content. Node recommends its temporary-directory default to avoid accumulating stale cache. A persistent Qwen-specific cache would require new cleanup, permissions, and lifecycle policy without evidence that it improves the measured path.

### Export `getCompileCacheDir()` unconditionally

Rejected. When the cache was enabled from an existing environment variable, the reported directory is already Node-version-specific. Reusing it as the next process's base creates another nested version directory and prevents the intended sharing.

## Failure and compatibility behavior

- Node without `enableCompileCache()`: no environment mutation and no behavior change.
- `NODE_DISABLE_COMPILE_CACHE=1`: Node reports disabled; no directory is propagated.
- Operator-provided `NODE_COMPILE_CACHE`: preserved verbatim and inherited normally.
- Unwritable or otherwise invalid cache directory: Node reports failure without throwing; Qwen Code continues without a cache.
- Node or Qwen upgrade: Node isolates incompatible runtime versions and source-content changes produce different cache entries.
- Coverage: the production fast path is the only mutation point. Unit-test runners are not globally opted into compile caching.
- Shutdown: Node writes accumulated code cache during normal process exit. Forced termination can lose newly generated entries but cannot affect correctness.

## Verification

Feasibility is gated before implementation using one identical release bundle for both variants. Both daemon variants receive the same warm parent-process cache. The control removes the cache environment before importing the bundle, so ACP descendants remain uncached; the candidate publishes the same base directory before import, so ACP descendants inherit it.

The 2-vCPU reference-host gate covers:

- 30 alternating paired cold daemon starts
- 30 alternating paired preheated starts
- `channel.initialize`, process-to-first-session, listener readiness, and peak RSS
- a warm second session
- concurrent first sessions
- telemetry enabled and disabled
- legacy single-session behavior
- empty-cache first use, warm-cache reuse, cache footprint, and residual processes

Implementation proceeds only if the child-specific warm-cache comparison shows a repeatable initialization or process-to-session benefit without a functional regression.

## Validation results

The gate ran on a 2-vCPU, 4-GB Linux x64 host with Node.js 22.23.1. The control and candidate used the same bundle from `77af061e` and differed only in whether the ACP child inherited the parent compile-cache directory.

Across 30 warm-cache paired runs, the candidate won every `channel.initialize` comparison. Its paired median improvement was 176.6 ms, with a bootstrap 95% confidence interval of 167.7–186.2 ms. The paired median process-to-first-session improvement was 199.0 ms, with a 95% confidence interval of 177.6–226.5 ms. The candidate's median peak process-tree RSS was 8.6 MB higher.

An additional 10-pair confirmation used the unmodified production entry from `origin/main` as the control and the patched production entry as the candidate. It reproduced a 181.6 ms median `channel.initialize` improvement and a 189.4 ms median process-to-first-session improvement.

Across 20 independent empty-cache pairs, the first process-to-session run was 117.2 ms slower at the median, with a 95% confidence interval of 69.3–130.9 ms. The second ACP startup therefore recovers the one-time generation cost under the measured workload. The stable cache contained 362 files and used 9.4 MB.

All measured runs completed successfully without residual processes. The candidate also passed concurrent first-session creation, telemetry-disabled startup, and legacy single-session behavior.
