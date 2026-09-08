# Daemon extension Skill catalog

This implements stage 2 of #11274. The daemon-local workspace Skill provider
currently supplies an empty active-extension list, so its first response omits
installed extension Skills when no child snapshot exists.

Use an unbound `ExtensionManager` for the selected workspace to load installed
extensions through the existing consistent store reader. Supply active
extensions to `SkillManager`, preserving project > user > extension > bundled
precedence. Append inactive extension Skills as management entries with the
existing `inactive_extension` status, retaining their identity and metadata.
Resolve settings and extension Skill defaults/overrides with the existing
parsers. A settings opt-in does not enable an inactive parent extension.
Resolve localized extension names with the existing language setting and locale
helpers on every response, without changing the daemon process language or
rebuilding the directory cache when only the language changes.

Keep the lightweight Config surface: do not construct a runtime Config, start a
child, initialize MCP, execute hooks, or install watchers. Honor safe mode,
disabled discovery levels and workspace trust; inert untrusted inventory must
not load workspace settings or extension runtime context. Directory failures
continue to return an uninitialized error status.

The implementation and collocated regressions live in the daemon-local provider.
Tests cover real manifests, active/inactive state, source collisions, persisted
Skill settings, safe/untrusted contexts and explicit cache invalidation. E2E
evidence uses an isolated home and a daemon with no child session.

The facade still prefers child snapshots in this stage. Replacing that source,
changing toggle/refresh semantics, adding configured-state fields and changing
Web Shell projections belong to later PRs. No public schema changes are needed.

Discovery-level disabling suppresses active extension Skills through
`SkillManager`; inactive extension management entries are still appended, as in
the child producer. Safe mode and untrusted contexts never load extensions.

An absent extensions root is an empty inventory; no extension store is created.
Unreadable roots and errors propagated by the shared store/loader return
`initialized: false` with explicit errors. Individual artifact handling remains
owned by the shared loader: malformed manifests are skipped with its diagnostic,
whereas a dangling extension entry propagates an error. This stage does not add
per-artifact diagnostics to the response or change the loader's failure policy.
Existing facade caching, source preference and invalidation behavior remain
unchanged; the tracking issue assigns cache lifecycle and concurrency changes
to stage 4.
