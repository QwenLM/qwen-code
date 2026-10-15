# Qwen Live extension on the merged M5 baseline

## Scope

Prepare the local visual input, Proactive, Memory, language/theme, subagent
status and desktop interaction work as one follow-up change to merged M5.
This is a local migration and review; publishing, a remote branch and a GitHub
PR are explicitly outside this preparation step.

The initial checkout was PR #10769 at `f7b0b88b2f`. M5 subsequently merged as
`829385a14e`. The migration targets the fetched main snapshot `078b924989`.
The original local work is retained in the backup branch
`backup/qwen-live-enhancements-20260908` at `ea4e78064e`; only that local delta
is transplanted onto `feat/qwen-live-enhancements`, not the old PR history.

## Conflict decisions and invariants

Three files overlap the upstream playback fixes. Both IPC receipt handlers
retain the upstream trusted-renderer guard, add renderer-readiness validation,
and retain the extension's epoch/outputId shape. The daemon binds actual Host
receipts to the extended session handlers. There is only one receipt path:
duplicate upstream-only session methods are not kept beside the extended ones.

The extension's provisional playback hold is used only for accepted,
non-muted output until the real Host receipt arrives. The v9 coordinator's
output identity, completion markers, epoch checks and session callbacks clear
it; it must not regress to the old M5 unbound-completion latch. Proactive
delivery acknowledgement is settled before the next FIFO item is released.

Automatically merged CLI changes must preserve the newer upstream runtime
ownership, discovery and pre-start checks. The shared qwen serve integration
remains screen-only and does not gain standalone Memory or shutdown authority.
Upstream release workflows and unrelated main changes remain untouched.

## Publication hygiene

Only source, tests, design documents, README, manifests and lockfiles are in the
candidate diff. Private configuration, captured audio/images, memory databases,
runtime logs and build outputs remain outside Git. Pattern scan hits are
reviewed test sentinels, not production credentials. Adapted Memory/Proactive
source retains the prototype's Apache-2.0 Alibaba copyright and identifies the
TypeScript modifications. Both npm and pnpm locks must agree with manifests;
unrelated package versions/metadata must not be downgraded during migration.

## Validation plan

Run builds and heavy test groups serially. Verify qwen-live and Host typechecks,
the repository build/bundle, focused CLI compatibility tests, complete Live and
Host tests, inert realtime/ACP integration tests, lockfile/format/lint checks,
and an independent source/transport replay. Reuse prior before/after UI evidence
but clearly distinguish it from tests executed against this migrated branch.
No tests may acquire real microphone/camera input, call paid providers or change
user preferences. Windows/Linux and physical Bluetooth behavior remain manual
verification items, not implied by a macOS mocked test pass.

Final local PR metadata follows the repository template and records the large
cross-package feature scope for maintainer review. The user elected one PR;
this is not a core-only refactor or a reason to silently omit features.
