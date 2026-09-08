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
With a present root the read reconciles through the shared store: a missing or
drifted store is initialized in place under the store's exclusive lock,
rewriting `extension-store/state.json`, creating its `state.previous.json`
rollback copy, and rewriting the legacy `extension-enablement.json` projection.
Once reconciled, later reads write nothing. Unreadable roots and errors
propagated by the shared store/loader return `initialized: false` with explicit
errors, and that failure is deliberately all-or-nothing: one bad extension
artifact (for example a dangling directory entry) fails the entire catalog,
project, user and bundled Skills included, until the artifact is repaired.
Individual artifact handling remains owned by the shared loader: malformed
manifests are skipped with its diagnostic, whereas a dangling extension entry
propagates an error. This stage does not add per-artifact diagnostics or
per-level degradation to the response, or change the loader's failure policy.
Existing facade caching, source preference and invalidation behavior remain
unchanged; the tracking issue assigns cache lifecycle and concurrency changes
to stage 4.

**Known later-stage items (recorded during review, deliberately not in this
stage):**

- The sibling `/workspace/extensions` route resolves its locale through
  `loadSettings` without `skipLoadEnvironment`, so a workspace `.env`
  `QWEN_CODE_LANG` can diverge from this provider's language resolution.
- The inactive-entry append and sort assembly duplicates the child producer's
  (`acpAgent.ts`), keeping the child's `level:extensionName:name` dedupe key.
- Extension mutations do not invalidate the config-catalog providers this stage
  populates, so a committed install, update, enable/disable or uninstall can
  leave stale extension Skill state on the skills config routes until an
  unrelated skill mutation, a workspace removal, or a restart. The
  invalidation wiring and `refreshCacheIfSourcesChanged` revalidation belong
  to stage 4.
- The active-Skill `enabled` judgment mirrors `Config.isSkillEnabled` by hand.
