# Composer draft attachments

[English](composer-draft-attachments.md) | [简体中文](composer-draft-attachments.zh-CN.md)

## Problem and scope

Unsent images and files must follow their text draft across session switches and page reloads. Text uses localStorage, whose quota is too small for 8 MiB attachments. Keep the existing text format and daemon protocol; store attachment payloads in IndexedDB under the same draft key.

The follow-up to [PR #15025](https://github.com/QwenLM/qwen-code/pull/15025) fixes two defects left by that change: losing an unsent archive during a Managed summary reload, and leaving an accepted draft behind after session allocation.

## Storage and restoration

Persist image payloads and file Blob/text payloads without adding protocol fields. Reuse the shared IndexedDB request helper for composer drafts, local directory handles, and managed pending requests; it creates their single object store directly. Resolve writes on transaction completion. Unavailable or failed storage leaves the in-memory composer usable and restores no archived attachments.

Keep one page-local draft session per draft key, shared by all mounted composers for that key. Main chat and a split pane showing the same session share text, inline/top reference tags, restored input annotations and attachment payloads immediately. Different session IDs keep separate entries. Focus, cursor, menus and history browsing remain view-local; temporary history previews do not replace the shared unsent draft.

The shared entry owns one in-flight attachment read. During restoration it records the latest attachment snapshot, removed visible payloads, and whether an explicit clear discarded the old archive. Returning to a draft or mounting a second view before its read completes reuses that read; completing another draft's read can update its archive but cannot update an unrelated composer. Aggregate pending file-ingestion batches across subscribed views so none can submit while another is still reading a new attachment. Reconnecting a view under its allocated session key republishes its existing pending count. Leaving a view removes its pending count. Unsubscribing the last view releases the entry and payloads once a pending read completes. Touch views hoist live inline file references into top cards using the same normalization as stored drafts. Text still uses its existing localStorage format and save debounce; another mounted view reads live text even before that save.

Attachment edits persist immediately, including edits queued during restoration. Each edit first connects to the shared session and updates its subscribed views, including host restores before passive initialization; that early connection preserves stored text and reads the attachment archive before saving new additions. Adding Z in main after adding Y in split retains both. Explicit removal, clear and accepted submission propagate to all same-key views instead of unioning old snapshots. Do not save outgoing attachment snapshots when switching drafts. Session creation explicitly moves the pending draft's text and attachments to its assigned session key and removes the retired pending storage records.

Workspace metadata updates do not reset attachments or cancel a pending read when the draft key stays the same. When an initially unknown workspace resolves, always read its attachment archive, even if there is no text entry. Merge any unscoped in-memory attachments into that read before saving them.

Track attachment capability changes with their draft key and explicit composer context. Disabling attachments for a destination must not clear the departing draft, including when the target context arrives before its session ID. Re-enabling the same key can resume restoration while workspace metadata resolves or a pending context change is cancelled.

Managed summary reloads retain the last known attachment capability for the same session. Missing metadata is not a revocation; an explicit capability response still applies immediately. Changing session or provider resets that retained capability.

While the current draft is restoring, disable submission and guard normal submission, history retry, and history-search submission. A one-shot host `composerInput.submit` waits for that read instead of being dropped; cancel the delayed send if its draft changes, the user edits the text, or the input effect is disposed. Adding attachments remains available. Merge those additions with the archive when the read completes. Match overlapping image and text-file payloads once per occurrence, preserving repeated attachments within either snapshot; use the existing filename suffix helper for different files with colliding names. Equal filenames or Blob metadata do not establish equal content.

An explicit clear discards the archive even if the read is pending. Later additions survive, without bringing back the cleared archive. Removing a visible chip while a read is pending excludes that matching payload from the eventual archive merge. Removing a different, newly added chip does not discard unread archived attachments. Unmounting detaches the active read from the UI.

## Accepted submissions

Capture the draft's edit counter at submission. Share counters by draft key across composer instances in the same page, so a callback from an unmounted instance observes edits made after remounting. Record text and file-reference card edits, attachment additions and the start of file ingestion synchronously, as well as explicit clears. Removing submitted attachments alone follows the same accepted-submission cleanup rule in active and departed views. Background persistence does not increment the counter. Text keeps its existing two-second save debounce; checking only persisted text cannot detect a recent edit. A delayed acceptance for an outgoing or unmounted draft clears storage only if both its saved text and edit counter still match the submitted draft. This also covers image-only prompts, which have no saved text entry. Clearing one key never invalidates another key's read. Existing same-session editor identity checks, including submitted-attachment removal semantics, continue to protect newer input. A pending ingestion in any sibling view also identifies newer input; accepting an older prompt cannot abort that read. Host-driven matching cleanup clears both live attachments and their archive; managed admission captures the same edit guard before its asynchronous request and checks it before fallback cleanup.

When a pending draft becomes a session, move the submission's cleanup key and edit snapshot to the allocated session only while the captured editor state still matches, allowing removal of submitted attachments. Reuse the accepted-submission cleanup predicate for this handoff; keep the host-facing continuation guard strict. Touch reference normalization preserves identity when there are no inline references to hoist. A delayed acceptance after navigation or unmount then clears the migrated archive. Compare the active draft key with that cleanup key to recognize a departed draft, including navigation back to a pending composer without a session ID. New input before allocation prevents that ownership transfer; edits made afterward change the destination counter and remain protected.

## Constraints and risks

IndexedDB is best-effort origin storage; quota failures and browser eviction can prevent restoration. This change does not add retention policy, cross-tab conflict resolution, or daemon-side draft storage. The pre-existing cleanup gap when an unscoped submission gains its workspace before allocation is deferred to a separate fix; the new attachment archive follows that same lifetime. A binary file restored concurrently with another attachment of the same name is preserved with a suffix rather than inferred to be identical from its metadata.

## Validation and acceptance

- Text cannot be submitted without its still-loading archived attachments; submission resumes after a successful or failed read.
- An accepted outgoing prompt does not delete attachments added after submission, even when the text is unchanged.
- The same protection holds after desktop or mobile composer remounts.
- A text-only or file-reference-only edit before the text save completes protects the remounted draft's attachments from an old acceptance.
- Switching to a draft without attachment support preserves the departing archive and the destination's unread archive; explicitly disabling the same draft still clears it.
- A same-session Managed summary refresh preserves unsent attachments throughout its loading gap; session/provider changes do not inherit the previous capability.
- Late workspace metadata preserves loaded and loading session attachments and waiting host submissions.
- Resolving a pending draft's workspace restores attachment-only archives and merges unscoped additions.
- Accepting A while B loads does not suppress B's restoration.
- Same-name files with different payloads keep both contents with unique names.
- Rapid A-B-A switching reuses pending reads without duplicating attachments.
- Main and split views of one session share text and attachments before persistence, including continued edits, removal, clear and accepted submit; stale views cannot overwrite or revive another view's attachments.
- Different session IDs remain isolated, including when both are split panes.
- Acceptance after allocation and navigation or unmount clears the migrated archive, while edits before or after allocation remain intact.
- Removing only a submitted attachment before allocation still permits accepted-draft cleanup. Touch allocation with persisted references does not invalidate an unchanged draft.
- Clearing and adding during a pending read does not resurrect cleared attachments.
- Host layout-time restores preserve their attachments with and without IndexedDB, and merge rather than replace existing archives. Existing session creation, chip removal, remount, disabled-capability, local-handle, and managed-pending storage tests remain green.

The test plan and reproduction evidence live under `.qwen/e2e-tests/` and `.qwen/issues/`. The installed global CLI does not contain this unpublished feature; delayed-read regression tests exercise the worktree's actual composer hook with an IndexedDB stand-in.
