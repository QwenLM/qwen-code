# Gitignore matcher caching

File discovery shares a compiled matcher between directories with the same
chain of contributing `.gitignore` files. A directory without additional rules
does not retain another compiled copy of every ancestor rule. Nested rules,
negation, directory-only patterns, and `.git/info/exclude` keep their existing
precedence; ignore files below an ignored ancestor are not consulted.

Transient directory memos and compiled matchers are discarded every 10,000
ignore checks, including memo hits. This also releases the matchers' internal
per-path result caches. Empty pattern lookups are discarded at that boundary;
already-loaded non-empty rules are retained. The interval is an internal
memory/performance tradeoff, not a user setting or a live reload mechanism.
Restart the session after changing ignore files.

This limits retention caused by repeatedly compiling the same rules, not all
memory used by a search. A sparse glob can still visit a large directory tree,
and loaded rules still scale with the number of contributing ignore files.
For generated outputs that should not be searched, add their directory to
[`.qwenignore`](../../users/configuration/qwen-ignore.md) so traversal skips the
subtree. The existing Glob result limit is unchanged.

Regression coverage checks retained matcher identity and cache rollover rather
than asserting platform-dependent heap sizes. A real CLI integration test uses
a local fake model endpoint to request a sparse glob over more than one cache
window, checking nested rules, re-inclusion, ignored ancestors, and `.qwenignore`.
