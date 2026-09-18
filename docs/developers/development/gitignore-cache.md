# Gitignore matcher caching

File discovery shares a compiled matcher between directories with the same
chain of contributing `.gitignore` files. A directory without additional rules
does not retain another compiled copy of every ancestor rule. Nested rules,
negation, directory-only patterns, and `.git/info/exclude` keep their existing
precedence; ignore files below an ignored ancestor are not consulted.

Transient compiled matchers are discarded before the next ignore query after
the production matcher-evaluation window has accumulated. The counter includes
both final path checks and ancestor-pruning checks performed while building a
matcher on a cache miss, so deep paths consume multiple units instead of
bypassing the bound. One query can cross the threshold; the rollover happens
before the following query. This also releases the matchers' internal per-path
result caches. Per-directory rule lookups, including empty `.gitignore` probes,
are retained for the session, and `.git/info/exclude` is read at most once per
process. The interval is an internal memory/performance tradeoff, not a user
setting or a reload mechanism. Restart the session after changing ignore files.

This limits retention caused by repeatedly compiling the same rules, not all
memory used by a search. A sparse glob can still visit a large directory tree,
and per-directory rule lookup memos still scale with directories visited while
loaded rules scale with the number of contributing ignore files. For generated
outputs that should not be searched, add their directory to
[`.qwenignore`](../../users/configuration/qwen-ignore.md) so traversal skips the
subtree. The existing Glob result limit is unchanged.

Regression coverage checks retained matcher identity and cache rollover rather
than asserting platform-dependent heap sizes. A real CLI integration test uses
a local fake model endpoint to request a sparse glob over more than one cache
window, checking nested rules, re-inclusion, ignored ancestors, and `.qwenignore`.
