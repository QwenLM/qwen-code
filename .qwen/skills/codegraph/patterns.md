# CodeScope Cypher Patterns

Run these via `cs.conn.execute(query)`. All queries return lists of tuples.

## Structural Queries

**Who calls a function?**

```cypher
MATCH (caller:Function)-[:CALLS]->(f:Function {name: 'free_irq'})
RETURN caller.name, caller.file_path
ORDER BY caller.name LIMIT 30
```

**What does a function call?**

```cypher
MATCH (f:Function {name: 'sched_fork'})-[:CALLS]->(callee:Function)
RETURN callee.name, callee.file_path
```

**Transitive callers (up to 3 hops):**

```cypher
MATCH (caller:Function)-[:CALLS*1..3]->(f:Function {name: 'kfree'})
RETURN DISTINCT caller.name, caller.file_path LIMIT 50
```

**Functions in a module:**

```cypher
MATCH (f:Function)<-[:DEFINES_FUNC]-(file:File)-[:BELONGS_TO]->(m:Module)
WHERE m.path_prefix = 'net/core'
RETURN f.name, file.path LIMIT 30
```

**Cross-module calls (e.g. fs → mm):**

```cypher
MATCH (f1:Function)-[:CALLS]->(f2:Function),
      (file1:File)-[:DEFINES_FUNC]->(f1),
      (file2:File)-[:DEFINES_FUNC]->(f2),
      (file1)-[:BELONGS_TO]->(m1:Module {path_prefix: 'fs'}),
      (file2)-[:BELONGS_TO]->(m2:Module {path_prefix: 'mm'})
RETURN f1.name, f2.name, count(*) AS calls
ORDER BY calls DESC LIMIT 20
```

**Fan-in and fan-out:**

```cypher
MATCH (caller:Function)-[:CALLS]->(f:Function)-[:CALLS]->(callee:Function)
WHERE f.is_historical = 0
WITH f, count(DISTINCT caller) AS fi, count(DISTINCT callee) AS fo
RETURN f.name, f.file_path, fi, fo, fi * fo AS risk
ORDER BY risk DESC LIMIT 20
```

**Module sizes:**

```cypher
MATCH (f:Function)<-[:DEFINES_FUNC]-(file:File)-[:BELONGS_TO]->(m:Module)
WHERE f.is_historical = 0
RETURN m.path_prefix, count(f) AS func_count
ORDER BY func_count DESC LIMIT 30
```

**Functions by name pattern:**

```cypher
MATCH (f:Function) WHERE f.name STARTS WITH 'irq_'
RETURN f.name, f.file_path LIMIT 20
```

```cypher
MATCH (f:Function) WHERE f.name CONTAINS 'alloc'
RETURN f.name, f.file_path LIMIT 30
```

## Evolution Queries

**Functions modified by a commit:**

```cypher
MATCH (c:Commit)-[:MODIFIES]->(f:Function)
WHERE c.hash STARTS WITH 'abc123'
RETURN f.name, f.file_path
```

**Commits touching a file:**

```cypher
MATCH (c:Commit)-[:TOUCHES]->(file:File {path: 'kernel/sched/core.c'})
RETURN c.hash, c.message, c.author
```

**Co-changed functions (modified together frequently):**

```cypher
MATCH (c:Commit)-[:MODIFIES]->(f1:Function),
      (c)-[:MODIFIES]->(f2:Function)
WHERE f1.id < f2.id
RETURN f1.name, f2.name, count(c) AS co_changes
ORDER BY co_changes DESC LIMIT 20
```

**Largest commits (most functions changed):**

```cypher
MATCH (c:Commit)-[:MODIFIES]->(f:Function)
RETURN c.hash, c.message, count(f) AS funcs_changed
ORDER BY funcs_changed DESC LIMIT 10
```

**Historical (deleted/renamed) functions:**

```cypher
MATCH (f:Function) WHERE f.is_historical = 1
RETURN f.name, f.file_path LIMIT 30
```

**Backfill progress:**

```cypher
MATCH (c:Commit) WHERE c.version_tag = 'bf'
RETURN count(c) AS backfilled
```

**Most frequently modified files:**

```cypher
MATCH (c:Commit)-[:TOUCHES]->(f:File)
RETURN f.path, count(c) AS commits
ORDER BY commits DESC LIMIT 20
```

## Composition Strategies

These patterns combine multiple query types for deeper insights:

**Semantic + Structural**: Use `cs.vector_only_search("error recovery")` to find semantically similar functions, then query the graph to check if they share callers or modules. This reveals hidden architectural patterns.

**Hypothesis Testing**: Query fan-in counts and MODIFIES counts for the same functions, then analyze correlation to validate architectural assumptions (e.g. "are the most-called functions also the most stable?").

**Evolution Forensics**: Find multi-module commits, examine which functions changed, and classify as refactoring vs feature vs bugfix by looking at how many modules and how many functions were touched.

**Dependency Archaeology**: Find zero fan-in functions (dead code candidates), check `is_historical` for ghost functions, then trace which commits removed their callers — this tells you when and why code became dead.

**Incremental Investigation**: Start with `cs.summary()` for high-level coverage, then check backfill state. If `MODIFIES` is sparse, use `TOUCHES`-based (file-level) analysis instead of function-level.
