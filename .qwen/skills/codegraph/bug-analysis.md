# Bug Analysis Workflows

Patterns for tracing GitHub bugs to code using CodeScope's graph + vector infrastructure.

## Table of Contents

- [Quick Start](#quick-start)
- [Single Issue Analysis](#single-issue-analysis)
- [Batch Bug Hotspot Analysis](#batch-bug-hotspot-analysis)
- [Custom Analysis Pipelines](#custom-analysis-pipelines)
- [Combining Bug Analysis with Structural Analysis](#combining-bug-analysis-with-structural-analysis)

## Quick Start

```python
import os
os.environ['HF_HUB_OFFLINE'] = '1'

from codegraph.core import CodeScope
cs = CodeScope(".codegraph")

# "Why does this project have so many bugs?"
results = cs.analyze_top_bugs("owner", "repo", k=10, label="bug")
for r in results:
    print(f"#{r.issue.number}: {r.issue.title}")
    if r.candidates:
        top = r.candidates[0]
        print(f"  -> {top.function_name} ({top.file_path})")

cs.close()
```

## Single Issue Analysis

### Basic Analysis

```python
result = cs.analyze_issue("openclaw", "openclaw", 43608)
print(result.format_report())
```

The result object (`BugAnalysisResult`) contains:

| Field              | Type                       | Description                                        |
| ------------------ | -------------------------- | -------------------------------------------------- |
| `issue`            | `ParsedIssue`              | Parsed issue with extracted paths/funcs/commits    |
| `candidates`       | `list[RootCauseCandidate]` | Ranked root cause locations                        |
| `path_matches`     | `int`                      | How many extracted paths matched graph File nodes  |
| `semantic_matches` | `int`                      | How many semantic matches were found               |
| `caller_traces`    | `int`                      | How many mentioned functions had traceable callers |
| `analysis_time_ms` | `float`                    | Total analysis time                                |

### Inspecting the Parsed Issue

```python
from codegraph.issue_fetcher import fetch_and_parse_issue

issue = fetch_and_parse_issue("owner", "repo", 1234)

# What the parser found in the issue body:
print(issue.extracted_paths)      # ['src/handler.py', 'src/db.py']
print(issue.extracted_funcs)      # ['handle_request', 'execute_query']
print(issue.extracted_locations)  # [('src/handler.py', 42), ('src/db.py', 15)]
print(issue.linked_commits)      # ['abc123...'] from linked PRs
print(issue.labels)              # ['bug', 'regression']
```

### Inspecting Candidates

```python
for c in result.candidates:
    print(f"{c.function_name} @ {c.file_path}")
    print(f"  Score: {c.score:.3f}")
    print(f"  Reasons: {c.reasons}")
    # Reasons examples:
    #   "mentioned in issue"
    #   "in mentioned file src/handler.py"
    #   "semantic match (0.85)"
    #   "caller of handle_request (2 hops)"
```

## Batch Bug Hotspot Analysis

### Find the Buggiest Code

```python
results = cs.analyze_top_bugs("owner", "repo", k=10, label="bug")

# Aggregate: which files appear across the most bug analyses?
file_counts = {}
func_counts = {}
module_counts = {}

for r in results:
    for c in r.candidates[:5]:  # top 5 per bug
        file_counts[c.file_path] = file_counts.get(c.file_path, 0) + 1
        func_counts[c.function_name] = func_counts.get(c.function_name, 0) + 1
        # module = first 2-3 path segments
        parts = c.file_path.split("/")
        module = "/".join(parts[:3]) if len(parts) >= 3 else c.file_path
        module_counts[module] = module_counts.get(module, 0) + 1

print("Files with most bug associations:")
for f, n in sorted(file_counts.items(), key=lambda x: -x[1])[:10]:
    print(f"  {f}: {n} bugs")

print("Functions with most bug associations:")
for f, n in sorted(func_counts.items(), key=lambda x: -x[1])[:10]:
    print(f"  {f}: {n} bugs")

print("Modules with most bug associations:")
for m, n in sorted(module_counts.items(), key=lambda x: -x[1])[:10]:
    print(f"  {m}: {n} bugs")
```

### Cross-Reference with Structural Hotspots

```python
# Are the buggiest functions also the riskiest (high fan-in x fan-out)?
hotspots = cs.hotspots(topk=50)
hotspot_names = {h.name for h in hotspots}

buggy_and_risky = [f for f in func_counts if f in hotspot_names]
print(f"Functions that are both structurally risky AND frequently buggy:")
for f in buggy_and_risky:
    print(f"  {f}: {func_counts[f]} bugs, hotspot risk present")
```

## Custom Analysis Pipelines

### Manual Bug-to-Code Mapping

When you don't have a GitHub issue but have a bug description:

```python
from codegraph.bug_locator import find_semantic_matches, trace_callers

# Semantic search: find code related to the bug description
matches = find_semantic_matches(cs, "gateway crashes when processing messages", topk=10)
for m in matches:
    print(f"  {m['name']} ({m['file_path']}) score={m['score']:.2f}")

# If you know which function is involved, trace its callers
callers = trace_callers(cs, ["handle_message", "process_data"], max_hops=2)
for t in callers:
    print(f"  Callers of {t['function']}:")
    for c in t['callers']:
        print(f"    {c['name']} ({c['file']}, {c['hops']} hops)")
```

### Linking Bugs to Commits

When issues have linked PRs with merge commits:

```python
issue = fetch_and_parse_issue("owner", "repo", 1234)

for sha in issue.linked_commits:
    # Find what the fix commit modified
    rows = list(cs.conn.execute(f"""
        MATCH (c:Commit)-[:MODIFIES]->(f:Function)
        WHERE c.hash STARTS WITH '{sha[:12]}'
        RETURN f.name, f.file_path
    """))
    if rows:
        print(f"Commit {sha[:12]} modified:")
        for name, path in rows:
            print(f"  {name} ({path})")
```

### Bug Pattern Detection

Find if multiple bugs point to the same subsystem:

```python
results = cs.analyze_top_bugs("owner", "repo", k=20, label="bug")

# Group bugs by the module of their top candidate
module_bugs = {}
for r in results:
    if r.candidates:
        top = r.candidates[0]
        parts = top.file_path.split("/")
        module = "/".join(parts[:2])
        module_bugs.setdefault(module, []).append(r.issue.number)

for module, bugs in sorted(module_bugs.items(), key=lambda x: -len(x[1])):
    if len(bugs) >= 2:
        print(f"{module}: {len(bugs)} bugs (#{', #'.join(str(b) for b in bugs)})")
```

## Combining Bug Analysis with Structural Analysis

### "Is this bug in a risky part of the architecture?"

```python
result = cs.analyze_issue("owner", "repo", 1234)
if result.candidates:
    top = result.candidates[0]
    # Check if the implicated function is a bridge function
    bridges = cs.bridge_functions(topk=50)
    bridge_names = {b.name for b in bridges}
    if top.function_name in bridge_names:
        print(f"Warning: {top.function_name} is a bridge function "
              f"(called from many modules) — bug may have wide impact")

    # Check module coupling
    couplings = cs.module_coupling(topk=20)
    # ...examine if the implicated module is tightly coupled
```

### "What would break if we fix this bug?"

```python
result = cs.analyze_issue("owner", "repo", 1234)
if result.candidates:
    func = result.candidates[0].function_name
    impacts = cs.impact(func, "bug fix", max_hops=3)
    print(f"Fixing {func} could affect {len(impacts)} callers:")
    for imp in impacts[:10]:
        print(f"  {imp.name} ({imp.file_path})")
```

## CLI Quick Reference

```bash
# Fetch and inspect a single issue (no graph needed)
codegraph fetch-issue owner repo 1234

# Fetch top bugs from a repo
codegraph fetch-bugs owner repo --top 10 --label bug

# Analyze a bug against indexed code
codegraph analyze-bug owner repo 1234 --db .codegraph

# Batch analyze top bugs
codegraph analyze-bugs owner repo --db .codegraph --top 10

# Force refresh (skip cache)
codegraph fetch-issue owner repo 1234 --no-cache
codegraph analyze-bug owner repo 1234 --db .codegraph --no-cache
```
