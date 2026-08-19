# Node REPL Runtime Implementation Plan

Issue: QwenLM/qwen-code#9333

## Delivery boundary

Deliver one focused phase-1 change: three deferred built-in tools, one
task-owned Node child, fresh SourceTextModule cells with `@prev` persistence,
process-level reset, output conversion, heap status, and an empty-by-default
trusted-context bridge. Do not include #9334 Computer Use code.

## Sequence

1. **Contract and documentation**
   - Synchronize Issue #9333.
   - Record the architecture in `docs/design/node-repl-runtime.md`.
   - Record baseline and post-change evidence in
     `.qwen/e2e-tests/node-repl-runtime.md`.

2. **Recover the safe baseline**
   - Port protocol framing, process-tree lifecycle, result conversion,
     permission-aware tools, registration, asset-copy hooks, and applicable
     tests from the previous Claude Code session.
   - Integrate each piece against current `origin/main`; do not overwrite
     newer `config.ts`, tool registry, build, or shutdown behavior.

3. **Replace persistence semantics**
   - Replace shared-context script/TLA-IIFE execution with a required
     tree-sitter Cell transform.
   - Create a fresh SourceTextModule per execution.
   - Add `@prev` SyntheticModule bindings, generated live exports, final
     expression capture, and statement-boundary partial snapshots.
   - Add closure, identity, assignment, redeclaration, parse/link failure,
     runtime failure, Unicode, and destructuring tests.

4. **Harden process and output behavior**
   - Make reset terminate the process and lazily spawn the next generation.
   - Make timeout and cancellation process-fatal with no replay.
   - Raise raw sanity limits above the 2 MiB / 20-image probes.
   - Apply approximately 10k-token truncation only in result conversion while
     preserving images.
   - Add synchronous `getHeapStatus()` without policy side effects.

5. **Implement the trusted bridge**
   - Keep model roots untrusted.
   - Classify host entries by package name, pinned canonical root, entry path,
     and SHA-256; reject roots whose realpath target changes after approval.
   - Pin workspace-symlink package targets, every allowed package file, and
     every trusted package-dependency edge; require a separate model-import
     allow flag and keep Node builtins deny-all.
   - Create separate normal and privileged `nodeRepl` realm objects.
   - Add token + generation + execution + operation validation around
     structured capability requests.
   - Give capability handlers separate execution- and generation-lifetime
     abort signals so future host sessions survive Cells but not reset/crash.
   - Keep the production capability map empty; validate with a test fixture.

6. **Wire and package**
   - Add tool/display names and lazy regular-registry registration.
   - Copy runtime `.mjs` assets for core-package, npm-bundle, standalone,
     Desktop, VSIX, and TypeScript SDK layouts.
   - Ensure registry shutdown disposes the shared manager exactly once.

7. **Verify**
   - Run focused parser, protocol, policy, converter, manager, tool, and real
     registry integration tests from `packages/core`.
   - Run the 100-cell and 10-kernel E2E driver against built output.
   - Run build, bundle, typecheck, focused lint/format, a minimal real CLI
     registration path, and the performance probes.
   - Record provider/infrastructure blockers separately from source failures.

8. **Review**
   - Read the complete tracked and untracked diff in open-ended passes.
   - Check architecture/security/lifecycle and test evidence independently.
   - Fix only valid #9333 findings, rerun affected gates, and require two clean
     passes after the last fix.

## Stop conditions requiring a new user decision

- adding a new runtime dependency instead of using the existing tree-sitter
  stack;
- adding a production trusted package, concrete Computer Use operation, new
  network listener, MCP dependency, or external install;
- changing Qwen's global permission owner or provider configuration;
- introducing memory-based automatic process termination;
- weakening process-level reset or the host-controlled trust boundary.
