# Web Shell Extension Archive Upload

## Problem

The CLI installs local `.zip` and `.tar.gz` Extension archives, but the Web Shell can only submit a textual Git, GitHub, or npm source. Browser files do not have a daemon-readable path, and the existing daemon install endpoint intentionally rejects local sources.

## Design

Add a dedicated `POST /workspace/extensions/install-archive` endpoint. The SDK sends the selected archive as `application/octet-stream` with the filename and explicit consent in query parameters. The endpoint accepts non-empty `.zip` and `.tar.gz` files up to 10 MB, writes the body to a temporary file, and submits the existing queued Extension install operation.

The temporary artifact path is used only while preparing the install. Persisted install metadata records an opaque per-upload identity plus the filename, while user-facing surfaces display `upload:<filename>`. Extension identity therefore remains unique without exposing or depending on a random temporary directory. The Extension manager accepts an optional local source path for prepared installs while retaining the caller-provided metadata source.

The Web Shell Add Extension dialog offers source and archive tabs. Archive installs reuse the existing operation polling, interactive settings/plugin prompts, session refresh, and status messages. The temporary upload directory is removed after installation preparation and commit finish, whether they succeed or fail.

## Security and failure behavior

- The route uses the existing strict mutation, workspace trust, client identity, operation admission, and explicit-consent checks.
- Only `.zip` and `.tar.gz` filenames are accepted.
- The raw body parser caps uploads at 10 MB.
- Archive extraction retains the existing traversal, symlink, and archive-shape protections.
- Uploaded bytes and the upload temporary path are not returned in operation records.

## Test plan

- Verify the CLI help still advertises local archive installation.
- Verify the daemon accepts a valid archive upload, passes a temporary artifact path with stable upload metadata to the Extension manager, and removes the temporary file after completion.
- Verify invalid filenames, missing consent, empty bodies, and unsupported content types are rejected.
- Verify the SDK sends the binary body, filename, consent, client identity, and content type to the new endpoint.
- Verify the Web Shell selects an archive and starts the existing install-operation flow.
