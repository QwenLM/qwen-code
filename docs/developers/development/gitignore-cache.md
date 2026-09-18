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
are retained for the lifetime of each parser, and `.git/info/exclude` is read at
most once per parser instance. A process can hold more than one parser, so a
parser created after an ignore-file edit can observe the new rules while an
existing parser keeps its snapshot. The interval is an internal
memory/performance tradeoff, not a user setting or a reload mechanism. Restart
the session to make ignore-file changes apply everywhere.

This limits retention caused by repeatedly compiling the same rules, not all
memory used by a search. A sparse glob can still visit a large directory tree,
and per-directory rule lookup memos still scale with directories visited.
Retained compiled matchers scale with contributing ignore-file chains: each
chain-prefix matcher replays the rules from the ignore files above it, so a long
nested chain costs more than one compiled rule set per contributing file. This is
mostly relevant to unusually deep ignore hierarchies; shallow shared chains are
the common case this cache optimizes. For generated outputs that should not be
searched, add their directory to
[`.qwenignore`](../../users/configuration/qwen-ignore.md) so traversal skips the
subtree. The existing Glob result limit is unchanged.

The deterministic core cache-retention suite pins matcher sharing, rollover,
and stable rule snapshots. A real bundled-CLI integration test separately pins
nested ignore and `.qwenignore` semantics through a sparse traversal that spans
more than one production matcher-evaluation window; it is not the discriminator
for the memory-retention fix itself.
