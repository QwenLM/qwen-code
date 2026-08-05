# GitHub Channel local `gh` authentication

## Problem

The GitHub Channel currently requires a classic personal access token in every configuration. This prevents Web Shell users from creating a channel that reuses the GitHub CLI authentication already available to the daemon host through `gh auth login`.

The separate Web Shell pull-request integration already relies on the daemon host's `gh` installation and authentication, but the Channel adapter passes only its configured `token` to Octokit.

## Proposed behavior

- Keep an explicitly configured channel token as the highest-priority credential.
- Add an explicit `useLocalGh` opt-in for reusing the daemon host's account-wide GitHub CLI credential.
- When the token is absent and `useLocalGh` is enabled, resolve a token by running `gh auth token --hostname <host>` in the Channel worker.
- Reject configurations that provide neither an explicit token nor the opt-in.
- Use `github.com` as the local `gh` authentication hostname for the default `https://api.github.com` API URL.
- Derive the hostname from a configured GitHub Enterprise `baseUrl`.
- Require `baseUrl` to use HTTPS before resolving a daemon host credential through local `gh` authentication.
- Fail Channel startup with actionable diagnostics when `gh` is unavailable or the selected host is not authenticated.
- Never persist or expose the token returned by `gh`.

## Changes

### GitHub Channel plugin

Make the managed `token` secret optional, remove it from startup-required fields, and add a `useLocalGh` boolean. Update the descriptions to explain that an explicit classic PAT overrides local GitHub CLI authentication. The plugin's management descriptor validates the resolved configuration during managed upserts and rejects one that provides neither a token nor the opt-in, so the daemon mutation boundary keeps the immediate save-time rejection the required token provided before, while `connect()` still rejects configurations whose runtime credential cannot be resolved.

### GitHub Channel adapter

Resolve credentials during `connect()` before constructing Octokit. Use `execFile` without a shell, a bounded timeout, and a bounded output buffer. Pass the selected hostname as a separate argument. The Channel worker already inherits the daemon's `PATH`, `HOME`, and related environment, so `gh` reads the daemon host's existing login.

### Web Shell

The descriptor-driven editor already supports optional secret and boolean fields. Expose `useLocalGh` and require either a preserved/non-empty token or the explicit opt-in before saving. An existing PAT can be cleared only when local `gh` authentication is selected. Update localized field text accordingly.

### Documentation

Document local `gh auth login` as an explicit opt-in and explicit PAT configuration as an override. Warn that the local credential is account-wide and preserve the recommendation to use a separate bot account because the authenticated account cannot trigger its own channel.

## Files affected

- `packages/channels/github/src/index.ts`
- `packages/channels/github/src/GithubAdapter.ts`
- `packages/channels/github/src/GithubAdapter.test.ts`
- `packages/cli/src/commands/channel/channel-registry.test.ts`
- `packages/web-shell/client/components/channels/channel-editor-state.ts`
- `packages/web-shell/client/components/channels/channel-editor-state.test.ts`
- `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`
- `packages/web-shell/client/e2e/visuals/screenshots.spec.ts`
- `packages/web-shell/client/i18n.tsx`
- `docs/users/features/channels/github.md`
- `docs/design/github-channel-gh-auth.md`

## Scope boundaries

- No automatic login or interactive `gh auth login` invocation.
- No GitHub App or fine-grained PAT support.
- No shared cross-package GitHub credential abstraction.
- No change to GitLab Channel authentication.

## Security considerations

The resolved token stays in memory and is passed only to Octokit. It is not written into settings or logs. The subprocess uses fixed arguments and no shell. Existing sender-policy and self-authored-comment protections remain unchanged.
