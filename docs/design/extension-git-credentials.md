# Authenticated HTTPS Git extension installs

## Status

Implemented for the daemon, Core extension manager, and TypeScript SDK. WebShell
selection UI is intentionally deferred.

## Problem

The daemon rejects every extension source URL that contains HTTPS userinfo.
That prevents users from installing a private repository with a narrowly scoped
personal access token, even when the token is limited to one repository. Passing
the credential through the source URL without additional handling would be
unsafe: Git can persist the URL in `.git/config`, process arguments can expose
it, and extension metadata, operation history, logs, or telemetry can retain it.

## Goals

- Accept generic HTTPS Git sources whose userinfo contains a username and/or
  token.
- Default old clients to a safe one-time install when they omit a persistence
  choice.
- Offer an explicit stored mode that remains updatable across daemon restarts.
- Keep credentials out of URLs after request validation and out of Git argv,
  remote configuration, artifacts, metadata, logs, operation history, and
  telemetry.
- Preserve identity and update behavior for every existing installation and
  every new installation without URL credentials.

## Non-goals

- Add the WebShell confirmation UI. A follow-up can use the
  `extension_git_credentials` capability to offer stored, one-time, or cancel.
- Accept credentials for npm, archives, SSH Git, or local sources.
- Migrate existing extension artifacts or Agent Plugin data directories.
- Revoke, rotate, or validate the repository scope of a user-provided token.

## Protocol

Both daemon install endpoints accept:

```ts
credentialPersistence?: 'stored' | 'one_time';
```

The field is valid only when `source` is an HTTPS URL with userinfo. Omission in
that case means `one_time`; supplying the field without userinfo is a `400`.
Credentialed sources must parse as Git after the existing public-network source
policy is applied. GitHub credentialed URLs bypass release downloads and use
Git clone directly.

The route decodes and validates userinfo before the operation is queued. Empty
userinfo, malformed encoding, control characters, NUL, CR/LF, usernames over
256 UTF-8 bytes, and passwords over 4096 UTF-8 bytes are rejected. The route
then removes userinfo. Only the clean URL and an in-memory credential object can
cross into Core.

One-time operation history does not include the source. Successful results
expose only `credentialPersistence`; stored results may additionally expose the
clean source and `credentialStorage` (`keychain` or `encrypted_file`). No
response contains a credential or authorization header.

## Git authentication

Clone, fetch, and remote listing always receive the clean repository URL. The
credential is supplied only in the Git child environment with Git's counted
configuration variables:

```text
GIT_CONFIG_KEY_0=http.<clean-repository-url>.extraHeader
GIT_CONFIG_VALUE_0=Authorization: Basic <base64(username:password)>
```

The key is scoped to the exact clean repository URL. Public Git operations keep
the existing system/global Git configuration isolation, redirect and proxy
disablement, and DNS/IP pinning. `GITHUB_TOKEN` uses the same header mechanism
instead of being inserted into a clone URL. Newly cloned remote extensions do
not copy the root `.git` directory into the installed artifact.

The child environment necessarily contains the short-lived header while Git is
running. The design protects durable product state and process arguments; it
does not claim to protect against an already-compromised same-user process that
can inspect another process's environment or system keychain.

## Stored credential lifecycle

Stored mode uses the existing hybrid secret storage. The system keychain is
preferred; when unavailable, the existing host/user-bound encrypted file is
used. The staged extension contains a mode-`0600` selector with only a version,
backend, and random secret key. The secret value is a JSON object containing
the username and password and never enters the artifact.

Preparation writes the secret and selector. An artifact commit activates the
selector; failed preparation and disposal delete an unselected secret. Update
resolves the selector before any network access and copies a newly controlled
selector into the replacement artifact. Missing, malformed, forged, or
unreadable managed selectors fail with `extension_credential_unavailable`
without modifying the installed artifact. A repository-provided selector is
always removed before the managed selector is written.

Uninstall commits artifact removal first and then best-effort deletes the
secret. Cleanup failure does not restore the artifact; it returns an
`extension_credential_cleanup_failed` warning so an operator can remove the
orphaned secret.

## One-time snapshots

After a one-time clone succeeds, durable install metadata is converted to the
new `snapshot` type. Snapshot metadata contains no repository source, ref,
commit, update flag, or credential. Catalog and status projections omit source,
report `credentialPersistence: one_time`, and report `not updatable`. An update
request fails with `extension_not_updatable`.

Telemetry uses the generic snapshot category rather than the repository URL.
This deliberately trades updateability for the absence of a durable repository
locator and credential.

## Identity compatibility

Each credentialed install generates a random 64-character lowercase hexadecimal
`installId`. Stored updates retain it; one-time snapshots reload it from install
metadata, so restart does not change activation or Agent Plugin data identity.
Uninstall followed by reinstall creates a new id.

Existing metadata without `installId` continues to use the current source/name
formula. Non-credentialed installs also keep that formula. No migration or data
directory movement is performed.

## Rollout

The daemon advertises `extension_git_credentials`. A later WebShell change can
gate its three-way confirmation on that capability: store and update, install
once without updates, or cancel before sending a request. Older daemons remain
detectable because they lack the capability and continue rejecting userinfo.
