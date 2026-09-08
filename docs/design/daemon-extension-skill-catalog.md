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
helpers, without changing the daemon process language. The resolved locale is
part of the provider cache key — recomputed from freshly loaded settings on
every call — because a language change reaches no invalidation point.

Keep the lightweight Config surface: do not construct a runtime Config, start a
child, initialize MCP, execute hooks, or install watchers. Honor safe mode,
disabled discovery levels and workspace trust; inert untrusted inventory must
not load workspace settings or extension runtime context.
`skills.disabledLevels` gates extension _discovery_ only; inactive-extension
management entries are appended regardless, matching the child producer.

Failure handling is two-tier. An unreadable extensions _root_ (or a configured
skills base directory) keeps the documented all-or-nothing behavior: an
uninitialized error status. "Unreadable" covers a root that exists but cannot
be listed — a regular file, an unlistable permission mode, or a dangling
symlink; the probe stats the entry before reading it precisely so a dangling
link's `ENOENT` is not mistaken for an absent root. The explicit `readdir`
probe is what surfaces that state — the store loader swallows listing errors,
so without the probe an unlistable root would silently yield an initialized
catalog missing every extension Skill. A fault _inside_ the extension load
itself (corrupt store state, a dangling extension symlink, lock contention)
degrades only the extension entries instead: the catalog is served initialized
with the project, user and bundled Skills, the failure is logged to the
daemon's stderr, and the degraded build is not cached so the next read retries
extension enumeration. A workspace that disabled the extension discovery level
opted out of the all-or-nothing tier: an unreadable root takes the same
degrade path as any other load fault for it, so the rest of its catalog stays
served.

Cache installs are guarded by a per-workspace invalidation epoch, so an
invalidation delivered while a cold build is in flight cannot be undone by
that build, and concurrent cold builds of one workspace are coalesced. Startup
`--extensions` overrides are not propagated here (the daemon's child spawn
generally does not carry them either).

The implementation and collocated regressions live in the daemon-local provider.
Tests cover real manifests, active/inactive state, source collisions, persisted
Skill settings, safe/untrusted contexts, explicit and mid-build cache
invalidation, language changes, the extension-load failure domain, unreadable
directory roots and discovery-level gating. E2E evidence uses an isolated home
and a daemon with no child session.

The facade still prefers child snapshots in this stage, and latches only
child-produced answers: daemon-local answers are re-requested on each
unlatched read (the provider's own manager cache keeps repeats cheap), so a
degraded extension enumeration retries on the next poll instead of freezing
for the rest of the pre-child window. Replacing that source, changing
toggle/refresh semantics, adding configured-state fields and changing Web
Shell projections belong to later PRs. No public schema changes are needed.

Known later-stage items (recorded during review, deliberately not in this
stage):

- The sibling `/workspace/extensions` route resolves its locale through a
  settings load that admits the workspace `.env` into the daemon's
  process-global environment, so a workspace `QWEN_CODE_LANG` can diverge the
  two panels of one page. This provider follows the documented daemon
  convention (`skipLoadEnvironment`); fixing the leak belongs to that route.
- The daemon normalizes `general.language` (a POSIX form such as
  `zh_CN.UTF-8`, an alias, or a native name) before resolving extension
  display names, while the child passes the raw setting string to
  `resolveLocalizableString`, so such a value shows a localized name
  pre-child and the English fallback once a child answers. Extracting one
  shared locale resolver — used by this provider, the child's
  `resolveLocaleForExtensions`, and the `/workspace/extensions` controller,
  preserving env-over-settings precedence — belongs to a follow-up.
- The inactive-append and sort assembly is a second copy of the child's
  (`acpAgent.ts`); extracting it into the shared
  `runtime/workspace-skills-mapping.ts` module — keeping the child's
  `level:extensionName:name` dedupe key — belongs to a follow-up.
- Retaining the cached `ExtensionManager` across skill-settings invalidations
  behind `refreshCacheIfSourcesChanged` needs invalidation provenance
  (extension-store mutation vs skill-settings mutation) that the current
  call sites do not carry.
- The active-Skill `enabled` judgment mirrors `Config.isSkillEnabled`;
  sharing that decision with core config belongs to a follow-up.
