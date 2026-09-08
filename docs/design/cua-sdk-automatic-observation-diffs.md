# Automatic Computer Use observation diffs

## Decision

The root goal is a direct migration of Codex's Computer Use skill onto the
public CUA SDK. The Qwen skill preserves Codex's `API surface` and `Workflow`
structure, prose order, action-batch example, and decision semantics. It changes
only the package import, typed API names and parameters, exact-window targeting,
automatic diff option, screenshot representation, and required client cleanup.
Automatic cursors and consistent full/diff/no-change behavior exist to support
that migration; they do not define a new model workflow.

`@qwen-code/cua-sdk/computer-use` owns observation revision cursors. Model and
application callers provide only an exact PID and window ID. The native
`accessibility.observation_revision.v1` request remains unchanged and receives
the last successful revision for that surface from the facade.

## State and concurrency

Each `ComputerUse` instance keeps a cursor keyed by PID and window ID. A cursor
is valid only for the driver generation that produced it. A successful full,
diff, or no-change response with stable element identity advances the cursor;
unsupported or unretained observations clear it.

Observations for one surface execute in call order so an older response cannot
replace a newer cursor. Different surfaces are not serialized together. A
driver generation change clears every cursor, and an observation retried after
reconnection explicitly requests a full tree.

`disableDiff: true` omits the saved base for one call and maps to the native
force-full flag. A successful full result becomes the next automatic base. The
legacy `forceFull` spelling remains a compatibility alias but is not part of
model guidance.

An incomplete capture clears the surface cursor and receives one bounded retry
without disabling diffs. If the retry remains incomplete, the facade returns
an explicit observation-only state with no actionable elements and tells the
caller to observe again normally after the UI settles or use the screenshot.

## Public guidance

The public observation options reject every cursor or native revision request.
Revision and lineage identifiers stay private to the facade, and raw native
responses are not returned. The normal result exposes text, elements,
screenshot, mode, and resync reason; protocol metrics are grouped under a
cursor-free diagnostics object.

The bundled skill preserves Codex's loop: initialize the target, perform one or
more actions, then observe before deciding what to do next. The SDK owns the
cursor, so the model never stores or sends revision identifiers. The skill
prefers the default diff output and uses `disableDiff: true` only when it needs a
fresh complete tree; it adds no per-action observation rule.

The skill requests screenshots only when AX text is incomplete, visual layout
matters, or observed behavior conflicts with AX state. Returned images use the
typed `{ mimeType, dataBase64 }` shape.

## Verification

Hermetic tests cover the initial full response, automatic diff/no-change,
one-shot diff disabling, incomplete-capture recovery, surface isolation,
invalid-base resync, unsupported capability, generation changes, and
same-surface concurrency. Type tests reject manual revision inputs and public
access to revision IDs or raw responses. A gated daemon integration test
exercises two observations without passing revision state.
