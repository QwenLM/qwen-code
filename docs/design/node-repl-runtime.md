# Session-Persistent Node REPL Runtime

Issue: QwenLM/qwen-code#9333. This is phase 1 of the persistent-kernel
Computer Use roadmap; #9334 supplies the first production trusted package and
desktop capabilities.

## Scope

Qwen exposes three deferred built-in tools:

- `node_repl`: execute JavaScript in one task-owned Node kernel;
- `node_repl_reset`: replace that kernel process;
- `node_repl_add_node_module_dir`: add an untrusted `node_modules` lookup
  root after the normal permission and workspace-trust checks.

They are registered through the regular tool registry. Deliberately minimal
`--bare` mode keeps its existing fixed tool set and does not register this
deferred family.

There is no MCP prerequisite, external install, `functions.exec`, nested tool
calling, `qwenSession` global, Computer Use API, cua-driver, browser API, or
unrestricted shell in this change.

The behavioral reference is the Codex `node_repl` contract observed while
planning #9333. The implementation is clean-room: no Codex runtime source,
binary, private package, or Computer Use Skill text is copied or shipped.
Generic model-facing REPL guidance may be adapted to the Qwen tool names.

## Ownership and process topology

```text
Config / ToolRegistry (one Qwen task/session)
  -> three deferred tool instances
       -> one shared NodeReplKernelManager
            -> zero or one lazy Node child process
                 fd3: kernel -> host NDJSON
                 fd4: host -> kernel NDJSON
                 -> persistent untrusted vm.Context
                 -> persistent trusted vm.Context
                 -> fresh vm.SourceTextModule for every REPL cell
```

The tool-family closure owns the manager. A separate `Config` creates a
separate closure and therefore a separate process, binding store, module-root
list, output collector, temp directory, trust policy, token, and generation.
`ToolRegistry.stop()` disposes every loaded member of the family; manager
disposal is idempotent.

The child runs with `--experimental-vm-modules`. stdout and stderr are data
streams only. Protocol frames use dedicated pipes, so user output cannot
forge a control frame. Its environment is built from a small locale/timezone
and Windows-runtime allowlist; credentials, dynamic-library injection
variables, `NODE_OPTIONS`, and `NODE_PATH` are not inherited.

## Tool contract and permission defaults

All schemas set `additionalProperties: false`.

| Tool                            | Required parameters | Optional parameters                                                 | Intrinsic permission               |
| ------------------------------- | ------------------- | ------------------------------------------------------------------- | ---------------------------------- |
| `node_repl`                     | `code: string`      | `timeout_ms` positive integer, default 30,000; `title` length 1..80 | `ask`; untrusted workspace: `deny` |
| `node_repl_reset`               | none                | none                                                                | `allow`                            |
| `node_repl_add_node_module_dir` | absolute `path`     | none                                                                | `ask`; untrusted workspace: `deny` |

The existing PermissionManager remains authoritative. Execution and add-root
are denied while the workspace is untrusted; reset remains available for
cleanup. The add-root tool validates that the path is an existing real
directory named `node_modules`, then stores the canonical path in the manager.
The permission prompt is bound to that canonical target. If the path changes
targets before execution, registration fails; if a registered directory is
later replaced by a symlink to another target, the root stops resolving.
Adding it never changes the trusted-package policy.

The `node_repl` description tells the model about the 30-second default,
top-level await, persistent bindings, redeclaration strategies, dynamic
imports, reset, partial commit, and the public `nodeRepl` APIs. It does not
claim Browser, Chrome, Computer Use, or nested-tool capabilities.

## Cell semantics

### Fresh modules and `@prev`

Every call is a new `vm.SourceTextModule`; user code is never wrapped in a
shared-context async IIFE. A host-side tree-sitter transform analyzes only
top-level JavaScript syntax and produces a module with:

1. a generated `import * as <unique> from '@prev'`;
2. mutable local bindings for previous names not redeclared by this cell;
3. a null-prototype snapshot containing the last committed values;
4. the user's source with commit snapshots inserted after top-level
   statements;
5. generated, collision-free exports for the current live bindings, the
   partial-commit snapshot, and an optional final-expression value.

`@prev` is a `vm.SyntheticModule` in the untrusted context. Its exports are
the actual values from the preceding cell, not serialized copies. Functions
therefore retain their original lexical environment and objects retain
identity.

Example behavior:

```js
// cell 1
const x = 1;
const readX = () => x;

// cell 2
const x = 2;
`${readX()}|${x}`; // 1|2
```

Previous names carried into a new cell are generated as mutable locals, so
`counter += 1` creates the next committed value. If a cell redeclares a name,
the new module-local declaration shadows the previous export. Top-level
`var` may be redeclared; model guidance still recommends reusing a binding,
renaming it, using `var`, using a block, or resetting when rerunning snippets.

### Partial commit

The transform initializes the partial snapshot with every previous binding.
After each completed top-level statement it snapshots bindings that are live
at that point. This produces the following behavior:

- successful evaluation commits all generated live exports;
- runtime failure commits the last snapshot reached before the failure;
- a declaration or assignment in a statement that did not finish does not
  replace its previous value;
- a declaration below a throw is not committed, including hoisted function
  declarations whose textual commit point was never reached;
- parse and link failures do not change the binding store.

The parser is required for execution. Failure to initialize or a parse tree
containing errors returns a structured error; there is no degraded transform
that silently changes persistence semantics. Source size, binding count, and
the statement-by-binding snapshot product are bounded before the generated
module can grow enough to exhaust the parent process.

The transform applies tree-sitter's JavaScript string offsets without
converting them to UTF-8 byte positions, and generated identifiers use a
bounded collision check against parsed identifier references and carried
binding names.

### Final expression

If the last top-level item is an expression statement, the transform captures
its value in a generated export. The kernel serializes it after earlier
console/`write` events. An execution without a final expression produces only
explicit output.

## Runtime globals

The untrusted context receives a frozen `nodeRepl` object:

```ts
type NodeReplHeapStatus = Readonly<{
  pid: number;
  generation: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  heapLimitBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
}>;

type NodeReplRuntime = {
  readonly cwd: string;
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly requestMeta: Readonly<Record<string, unknown>>;
  write(value: unknown): void;
  emitImage(
    image:
      | string
      | Uint8Array
      | ArrayBuffer
      | { bytes: Uint8Array | ArrayBuffer; mimeType: string },
  ): Promise<void>;
  setResponseMeta(meta: Record<string, unknown>): void;
  getHeapStatus(): NodeReplHeapStatus;
};
```

The object and every returned metadata object are created and frozen inside
the VM realm. Host callbacks are captured only by context-realm wrapper
closures, so model code cannot obtain a parent-realm function through an API
property. Request metadata and heap snapshots cross the bridge as JSON before
being reconstructed in that realm. Host timers invoke a bootstrap-owned realm
wrapper, never a model callback or thenable directly.

`getHeapStatus()` is a synchronous snapshot using `process.memoryUsage()` and
`v8.getHeapStatistics()` in the child host. It is never sampled
automatically. #9333 adds no memory threshold, watchdog, LRU, automatic reset,
or automatic process kill.

Timers and console methods are also context-realm wrappers. Each timer is
tagged with the current execution id. Once an execution is sealed, output and
privileged requests carrying that id are rejected rather than reassigned to a
later call.

## Module loading

The first release supports ESM only.

- Relative `.js` and `.mjs` imports resolve from the current module, remain
  inside canonical readable roots, and execute in the untrusted context.
- Bare packages resolve by scanning registered module roots in registration
  order. `exports` uses `import` then `default`; `module`/`main` are fallback
  entry fields.
- CJS, JSON-as-code, Node builtins, `require`, worker threads, and
  `child_process` are unavailable to untrusted modules.
- Untrusted local-module caches are cell-scoped. Explicit REPL bindings are
  the persistence mechanism.
- A trusted entry may import only additional files whose canonical paths and
  SHA-256 digests are pinned in its host policy. Bare dependencies must be
  separate hash-pinned trusted-package entries and must also be named in the
  importer's dependency allowlist. Undeclared files, packages, subpaths, CJS,
  and Node builtins are rejected. The phase-1 builtin allowlist is deliberately
  empty; host functionality crosses the structured capability broker instead
  of injecting parent-realm builtin exports.
- Trusted package modules may remain cached for one process generation and
  are destroyed by process-level reset.

The loader and image-file resolver recheck realpaths at access time and
require each configured root to still resolve to its pinned canonical path.
Symlinks cannot move either a root or a file outside the host-approved target
after validation.

## Trusted context and host bridge

The trusted-package registry is empty in production for #9333. Tests register
one temporary package and one fake capability; #9334 supplies the first real
package and handlers.

Trust requires all of the following:

- the bare package name matches a host policy entry;
- the canonical module root matches that entry;
- the canonical package-directory target, including a workspace symlink
  target, matches the host-pinned directory;
- the resolved canonical entry path exactly matches the host-pinned entry and
  stays under the expected package directory;
- the entry SHA-256 matches the host-provided digest.

Every additional trusted file is pinned by canonical path and SHA-256.
Package-to-package imports require an explicit edge between two independently
pinned trusted entries. Every entry is hidden from model imports unless the
host separately sets its model-import flag. This lets #9334 expose only
`@qwen-code/computer-use`, keep raw SDK dependencies non-importable, and use a
normal multi-file workspace package without turning the workspace or its
`node_modules` tree into a trust source. A model cannot bypass that decision
with a `file:` URL or relative path into a trusted package directory; trusted
files are reachable only through their approved bare package graph.

Model-provided roots are never trust inputs. A matching package loads in the
separate trusted context. An import crossing between contexts is represented
by a `SyntheticModule` in the importing context after the target module has
evaluated. A host-configured trusted root is consulted only for its matching
package; it does not become an untrusted lookup root and cannot make sibling
packages importable.

The trusted context receives its own frozen `nodeRepl`. Its public runtime
methods match the normal object, and it additionally has an internal
`callHost(operation, args)` method for trusted packages. The method serializes
arguments in the trusted realm and sends a capability request through the
kernel protocol. The parent validates:

- a cryptographically random token generated for this process generation;
- the current generation;
- the current execution id;
- a unique capability-request id;
- an exact operation name present in the manager's capability map.

The token remains in the child host and protocol code; it is not inserted into
either VM. Results cross the boundary as JSON, not as parent functions,
streams, handles, or arbitrary objects. Reset, timeout, cancellation, crash,
and disposal reject pending requests and revoke the old token/generation.
Capability handlers receive both an execution-scoped abort signal and a
generation-scoped abort signal. The former seals one Cell; the latter remains
live across Cells and is aborted on reset, timeout, cancellation, crash, or
task disposal so #9334 can own and immediately revoke a generation-bound
desktop session.

Every host-callback failure and dynamic-loader failure is converted to a new
`Error` owned by the receiving VM realm before model code can catch it. This
prevents a rejected host promise or filesystem error from leaking a parent
Realm constructor path into either context.

The trusted context exposes only a frozen process facade containing inert
metadata required by the phase-1 fixture. It has no `binding`, `mainModule`,
stdio, exit/kill/signal control, unrestricted environment, or parent process
object. Both VM contexts use `codeGeneration: { strings: false, wasm: false }`.

The trusted package's reviewed public namespace is the intended capability
surface visible to model code. Cross-realm constructor/prototype paths cannot
expose the privileged global or broker itself.

## Protocol

NDJSON frames are length-checked incrementally. Host-to-kernel frames are
`init`, `exec`, `addModuleRoot`, `capabilityResult`, and `shutdown`.
Kernel-to-host frames are `ready`, ordered output events, `execResult`,
`addModuleRootResult`, `capabilityRequest`, trusted-module `audit`, and
`fatal`.

Every capability request carries its token, generation, execution id, unique
request id, and operation; capability results correlate by that request id.
Unknown message types, oversized frames, and invalid JSON are protocol
failures. Invalid capability owners are rejected, and already-revoked stale
results are dropped. A protocol failure makes the current process unusable;
the manager kills it and advances generation.

Debug logging records process-generation revocation, non-content execution
statistics, hash-pinned trusted-module loads, and approved capability
operations. It does not log capability arguments, results, user output, or
the generation token.

## Output layers

The kernel preserves ordered text and image events. Matching wide sanity
limits in the child and manager stop an unbounded pipe backlog while remaining
above the compatibility probes: at least 2 MiB of text and 20 small images can
cross the raw boundary. The child reports raw truncation and dropped-image
counts in `execResult`. These limits and the per-frame limit protect allocation
but are not used as the model-context budget.

The result converter then:

- serializes strings, structured values, BigInt, functions, symbols, errors,
  and cyclic objects without breaking the protocol;
- validates PNG/JPEG/WebP magic bytes and declared MIME;
- permits `data:` URLs and canonical `file:` URLs under the workspace or
  session temp directory;
- truncates model-facing text to approximately 10,000 tokens using Qwen's
  token estimate and adds an explicit truncation marker;
- preserves valid image parts in their original order after text truncation.

Existing provider-wide image validation remains downstream. `setResponseMeta`
shallow-merges plain objects for only the active request, subject to a wide
cumulative protocol sanity limit.

## Lifecycle

- The manager starts no process until the first execution.
- Executions and mutations are serialized per manager.
- Timeout or AbortSignal cancellation kills the whole child process tree,
  revokes the generation, and never replays source.
- Unexpected child exit returns a structured crash result; the next call may
  lazily start a new generation and old bindings are reported lost.
- Reset is process replacement, not context replacement. It kills the old
  tree immediately and leaves no child running until the next execution.
- Canonical untrusted module roots live in the manager and are passed to the
  next generation.
- Task shutdown kills descendants, rejects in-flight calls, closes pipes, and
  removes the session temp directory.

## Packaging

The plain `.mjs` kernel and loader are copied into package `dist` beside the
compiled TypeScript and into a stable `node-repl-runtime/` bundle asset
directory. The existing wasm-binary build plugin embeds the JavaScript
tree-sitter grammar in the single-file CLI bundle. The same build dependency's
grammar file is also copied into both release layouts, so an installed core
package never depends on a development-only module at runtime; source
execution retains the installed-file fallback. The standalone archive
allowlist treats `node-repl-runtime/` as required runtime content and copies it
under `lib/` with the rest of the bundle assets. Desktop and VSIX assembly also
reject an incomplete root bundle before copying it, including when their
lower-level copy scripts are invoked directly. The TypeScript SDK's vendored
CLI layout carries the same directory; its npm-input path remains compatible
with older CLI packages that predate `node_repl`.

## Deliberate non-goals

- production Computer Use capabilities;
- CJS execution in either VM;
- hard-sandbox claims for Node `vm`;
- memory pressure policy;
- automatic output persistence outside normal ToolResult handling;
- MCP transport;
- byte-for-byte Codex compatibility.
