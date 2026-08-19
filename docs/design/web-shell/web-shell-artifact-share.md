# Web Shell HTML artifact sharing

## Goal

Give an HTML artifact card a third action, next to Download and Open, that uploads the artifact to Aliyun OSS and hands back a link the user can send to someone who cannot reach the workspace or the daemon.

## Problem

An HTML artifact is only viewable by whoever can reach the daemon that produced it. Sharing one means downloading the file and uploading it by hand, every time.

The upload target cannot be baked in — Qwen Code operates no hosting service, and silently posting a user's artifacts to a third party would be a privacy failure. But the project already answers that question: `ArtifactPublisher` in core publishes artifacts through a `local`, `host`, or `oss` backend, configured under `artifact.*`. A second, unrelated publishing path would make a user who already configured artifact publishing configure it again.

## Design

Sharing reuses the existing publisher. The Web Shell asks the daemon to publish a workspace file; the daemon constructs `OssPublisher` and returns the URL. Nothing is uploaded from the browser.

Only the OSS backend is wired up in this first pass. `local` produces a `file://` URL, which is not shareable, and `host` runs a user-supplied command whose semantics vary too much to expose from a dialog without more design.

### Where the destination lives

Nothing the dialog collects is written to disk, and no settings key is added. Existing `artifact.oss.endpoint` and `.bucket` values seed the dialog, so a user who already configured the artifact tool does not retype the destination, but the share flow only ever reads them.

What the user types is held by the running daemon, keyed by workspace, and forgotten when the process exits. The dialog says so rather than offering a choice: persisting a secret is the kind of decision that should be made deliberately in a settings file, not as a checkbox next to an upload button.

Credentials resolve in this order, first hit wins:

1. the current request, from what the user typed
2. the daemon's process memory, from an earlier share this run
3. `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` (or `ALIBABA_CLOUD_*`) in the daemon's environment

Settings are deliberately absent from that list. The environment remains the way to make a credential survive a restart. The dialog reports which source is in play, and typing a key overrides it for that upload.

`artifact.publisher` is deliberately **not** consulted. That setting selects the backend for the artifact _tool_; sharing is a separate action. Requiring the tool to be switched to `oss` would force a user who wants local artifacts to give that up to share one page.

### Routes

`GET /workspace/artifact/publish-config` reports the destination the daemon would use and which credential source it found — never the credential itself.

`POST /workspace/artifact/publish` takes `{ path, title?, config?, remember? }` and answers `{ id, url, reachable, reachableStatus }`. Fields omitted from `config` fall back to memory, then to settings. `remember: 'memory'` keeps that call's destination and credentials in the daemon process until it exits, which is what the dialog always sends.

Both routes exist in primary and workspace-qualified form, and the qualified form resolves its filesystem from the request's workspace runtime rather than the primary's.

### Reachability

The publisher applies a `public-read` object ACL, but a bucket that blocks public access overrides it, and the upload still reports success. The daemon therefore issues a `HEAD` against the returned URL and reports the outcome, so a link that 403s is named as such instead of being handed over as if it worked. A probe that cannot complete reports `null` — unknown, not broken.

### Reading the file

A single workspace read returns at most `MAX_READ_BYTES` (256 KB) and rejects a larger `maxBytes` outright, so the route walks the file window by window and concatenates before publishing. Asking for the whole document in one read fails on any page above that size — which is most real reports.

### Publishing semantics

The file is published byte-for-byte. The artifact tool's `validateSelfContained` check and `wrapArtifactHtml` wrapper are skipped: sharing targets a complete page the agent already wrote, not a fragment, and rejecting external references would be wrong for an arbitrary report.

Identity comes from `artifactIdFromPath`, so re-sharing the same file redeploys to the same URL rather than littering the bucket with copies.

### Flow

The Share action appears on an artifact card when the artifact is HTML (`kind === 'html'`, an `.html`/`.htm` path, or a `text/html` MIME type) and is readable from the workspace — the same availability rule Download uses.

Clicking it opens a dialog prefilled from `publish-config`, with endpoint, bucket, and an AccessKey pair, and a note that what is entered lives only in the running daemon. Key prefix and public base URL are not exposed — both have workable defaults and neither belongs in the path of a one-off share. Nothing uploads until the user presses Upload.

## Security

The artifact is model-generated HTML, so a published page can run arbitrary script under the bucket's origin. A bucket used for shared artifacts should host nothing else. Web Shell's preview sandbox (`withArtifactPreviewCsp`) does not apply to the published copy.

No credential the dialog collects reaches disk. It lives in the daemon process and dies with it, so a shared machine is not left holding an AccessKey in a settings file, and no repository can pick one up from a committed project settings file.

## Alternatives considered

**A browser-side upload to a user-supplied endpoint.** Implemented first and withdrawn. It needed no daemon changes, but duplicated `ArtifactPublisher`, put the credential in `localStorage`, and left users to deploy their own endpoint because no mainstream service accepts a POST of raw HTML and serves it back as `text/html` — general-purpose file and paste hosts deliberately refuse to, since rendering a stranger's HTML on their own origin is an XSS vector.

**Publishing through the agent child process,** where the tool's `Config` already lives. The daemon's session bridge has no `Config`, and reaching the child would need a live session and a round trip through ACP for what is a stateless file upload.

**Requiring `artifact.publisher: 'oss'`.** Rejected as described above: it conflates the tool's backend with the share action's.

**Offering to persist the destination and credentials to project or home settings.** Built and removed. It saved retyping across daemon restarts, at the cost of two new settings keys holding a plain-text secret, a scope picker next to the upload button, and — for project scope — a credential inside a file that can be committed. Keeping the credential in process memory and pointing at the environment for anything durable is the smaller and safer surface.
