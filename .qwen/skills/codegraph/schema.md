# CodeScope Graph Schema

## Nodes

| Node       | Key Properties                                                                                               | Notes                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `File`     | id, path, language, loc, is_external                                                                         | `is_external=1` for system headers / library stubs            |
| `Function` | id, name, qualified_name, signature, file_path, start_line, end_line, doc_comment, class_name, is_historical | `is_historical=1` for deleted/renamed functions               |
| `Class`    | id, name, qualified_name, file_path                                                                          |                                                               |
| `Module`   | id, name, path_prefix                                                                                        | Auto-discovered from directories (e.g. `kernel/sched`)        |
| `Commit`   | id, hash, message, author, timestamp, version_tag                                                            | `version_tag='bf'` means MODIFIES edges computed              |
| `Metadata` | id, value                                                                                                    | Pipeline state (e.g. `oldest_commit`)                         |
| `PR`       | id, title, author, risk_level, label                                                                         | Open pull request; populated by `codegraph pr-review prepare` |
| `AUTHOR`   | login, name, company, location, bio, avatar_url                                                              | GitHub user who opened the PR                                 |

## Edges

| Edge            | From → To           | Meaning                                                                                                                           |
| --------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `CALLS`         | Function → Function | Static call graph (resolved from AST)                                                                                             |
| `DEFINES_FUNC`  | File → Function     | File defines this function                                                                                                        |
| `DEFINES_CLASS` | File → Class        | File defines this class                                                                                                           |
| `HAS_METHOD`    | Class → Function    | Class contains this method                                                                                                        |
| `IMPORTS`       | File → File         | Include / import dependency                                                                                                       |
| `BELONGS_TO`    | File → Module       | File belongs to this module                                                                                                       |
| `INHERITS`      | Class → Class       | Class inheritance                                                                                                                 |
| `COMPOSES`      | Class → Class       | Composition relationship (strong ownership, filled diamond in UML)                                                                |
| `AGGREGATES`    | Class → Class       | Aggregation relationship (optional/weak, open diamond in UML)                                                                     |
| `USES`          | Class → Class       | Dependency relationship (uses per-call, dashed arrow in UML)                                                                      |
| `MODIFIES`      | Commit → Function   | Commit changed this function (requires backfill)                                                                                  |
| `TOUCHES`       | Commit → File       | Commit changed this file (always present)                                                                                         |
| `CHANGES`       | PR → Function       | PR modifies this function; `info` = 'hunk' (modified in diff), 'deleted' (removed), 'related' (newly called), 'new' (newly added) |
| `OPENS`         | AUTHOR → PR         | Author opened this PR                                                                                                             |

## Backfill State

Not all commits have MODIFIES edges — only those with `version_tag = 'bf'`. TOUCHES edges are always present for all ingested commits.

```cypher
MATCH (c:Commit) WHERE c.version_tag = 'bf' RETURN count(c) AS backfilled
```

```cypher
MATCH (c:Commit) RETURN count(c) AS total_commits
```

## Neug Cypher Reference

**Supported syntax:**

- `MATCH`, `WHERE`, `RETURN`, `ORDER BY`, `LIMIT`, `WITH`
- Aggregations: `count()`, `count(DISTINCT x)`
- Inline property filters: `{name: 'foo'}`
- Variable-length paths: `[*1..3]`
- String predicates: `STARTS WITH`, `CONTAINS`, `ENDS WITH`
- Comparisons: `=`, `<>`, `<`, `>`, `<=`, `>=`
- Boolean: `AND`, `OR`, `NOT`

**Limitations:**

- Chained `MATCH` after `WITH` may be limited — prefer single `MATCH` clauses with multiple patterns separated by commas
- No `CREATE`, `SET`, `DELETE` via Cypher — graph mutations go through the Python API
