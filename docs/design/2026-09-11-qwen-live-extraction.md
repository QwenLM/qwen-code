# Retire built-in Live Voice after standalone extraction

Qwen Live now has its own repository at
[QwenLM/Qwen-Live-Harness](https://github.com/QwenLM/Qwen-Live-Harness).
The extraction starts from `f649d65d1f49b049c7dac3365617d6d02f0a4cfe`,
the merge of #11369, and completes the repository-ownership part of #10118.

The new repository owns the standalone voice daemon, macOS Host, native Appshot,
realtime protocol, permission/result injection, visual input, Proactive, Memory,
onboarding, integration fixtures and Host/npm release workflows. Its first
paired candidate version is 0.3.0, protocol v9; the old published Host is v7
and cannot substitute for that paired release.

## Qwen Code's remaining responsibility

Qwen Code remains an optional backend through ACP or public serve REST/SSE.
Normal session creation, prompts, cancellation, attachments, permission voting,
steering, Conversations runtime management and cross-session messaging remain
owned here. They do not require the voice application.

Remove only built-in Live Voice: its daemon coordinators, Host discovery owner,
installer/routes/settings, injected screen/task/speech tools and realtime
transcript writer. Remove Web Shell's Live Voice entry and the obsolete SDK
Live HTTP methods alongside those routes. Existing one-shot speech input is
separate and remains available.

The existing public SDK methods are removed intentionally, so the SDK minor
version advances from 0.1.12 to 0.2.0. The extraction's standalone REST adaptor
uses generic session APIs, not the removed Live endpoints.

## Preserve existing sessions and user state

Conversations, session live-state, recovery journals and the live agent panel
are ordinary backend runtime features despite their names. They remain.
Historical `realtime_message` records remain readable. Persisted source and
relocation identifiers used by old Conversations data retain their compatibility
meaning even though the voice-specific writer is removed.

Conversations ownership must no longer claim or delete the voice application's
discovery file. The independent daemon and normal Conversations can coexist;
each retains its own process/nonce/lease checks for its own state.

No migration command deletes or rewrites `~/.qwen-live`, its Memory or transcripts,
or the Host user-data directory. The new Host preserves the existing app name,
bundle ID and signing identity. Only version-controlled files in this cleanup
branch are retired; the baseline commit preserves the original implementation.

## Delivery and validation

The two repositories must be reviewed together. The new repository must pass
independent dependency installation, build/typecheck, Host protocol tests,
fake-provider/ACP full-process tests and a production tarball installation with
no bundled backend CLI. This repository must build and typecheck, keep its
generic backend tests green, and update generated schemas, workspace/lock files
and release/test inventories.

The user explicitly deferred M3 from this migration. Both repositories retire
the private Live activation/speech RPCs. Normal deterministic turn-completion
notifications, permission reminders and steering remain available through
ACP/REST. The former injected mid-turn speech tool does not remain as a fallback.
Public peer discovery, user-controlled controller credentials and mid-turn peer
reports belong to the separate M3 follow-up, not to this migration.

Before the first public release, configure signing/notarization, the new
repository's distribution credentials and npm publisher. Retire these old Live
publishers before the new repository updates the shared public Host feed. No
new pull request or production release is created by this design document.
