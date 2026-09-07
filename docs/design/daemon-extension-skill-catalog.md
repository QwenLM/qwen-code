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
helpers, without changing the daemon process language.

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
