# Analyzing PR Impact with CodeGraph

A reusable workflow for analyzing the structural impact of all open PRs in a GitHub repository using [codegraph-ai](https://pypi.org/project/codegraph-ai/).

The workflow covers: fetching all open PRs via GitHub API → fetching branches → building the code graph index → computing multi-dimensional risk signals per PR → writing a prioritized report to a file.

---

## Prerequisites

- Python 3.10+
- `git` with access to the target repo and the contributor's fork
- `codegraph-ai` installed in an isolated virtual environment (see below)

---

## Step 1 — Set up the virtual environment

```bash
python3 -m venv ~/codegraph-venv
source ~/codegraph-venv/bin/activate
pip install codegraph-ai
```

---

## Step 2 — Fetch all open PRs and their branches

PR fetching is handled by `GitHubClient` in `pr_analysis.py`. It uses `gh pr list` to paginate and optionally filters by author:

```python
from codegraph.pr_analysis import GitHubClient

gh = GitHubClient(repo='owner/repo')  # uses gh auth login for auth
prs = gh.fetch_open_prs()    # all open PRs
# prs = gh.fetch_open_prs(author='someone')  # filtered by author
entries = [gh.pr_to_entry(pr) for pr in prs]
```

Authenticate via `gh auth login` before running. Set `GITHUB_TOKEN` as an environment variable to avoid rate limiting.

For each PR, GitHubClient internally uses `gh pr diff` (or local git as fallback) to fetch the diff. Cross-PR branches are fetched via `git fetch` when needed:

```python
git remote add <author> https://github.com/<author>/<repo>.git
git fetch <author> <branch>:<author>/<branch>
```

The local ref is `<author>/<branch>`. If the branch cannot be fetched (e.g. fork deleted), the PR is skipped with a message.

---

## Step 3 — Build the code graph index

```bash
source ~/codegraph-venv/bin/activate
cd /path/to/repo

codegraph init --repo . --lang javascript --commits 300 --db .codegraph
```

Key flags:

- `--lang javascript` — use this for TypeScript projects; the `JsAdapter` handles `.ts`/`.tsx` files. Using `--lang typescript` invokes the same adapter but may silently fall back to JS-only file detection on some versions.
- `--commits 300` — ingest git history to enable co-change and hotspot queries.
- `--db .codegraph` — store the index in the repo root (add to `.gitignore`).

> **Note:** Do not query functions by joining `Function` and `File` nodes (e.g., `file.path ENDS WITH ...`). The `Function` node stores the full path in `f.file_path`. Always query with `f.file_path ENDS WITH '...'`.

---

## Step 4 — Run the unified PR review pipeline

The authoritative entry point is `pr_review.py` — a unified pipeline that combines:
- Per-PR structural risk scoring (blast radius, test coverage, interface changes, etc.)
- Cross-PR graph analysis (connected components, shared callers, function conflicts)
- A single Markdown report with three prioritized sections

### Usage

```bash
source ~/codegraph-venv/bin/activate
cd /path/to/target/repo

# Phase 1: Analyze PRs, detect conflicts, write to graph DB (full rebuild)
codegraph pr-review prepare \
  --db /path/to/repo/.codegraph \
  --output /tmp/pr_review

# Phase 2: Apply labels and post conflict comments from graph DB
codegraph pr-review label \
  --db /path/to/repo/.codegraph

# Label with dry-run (preview without API calls):
codegraph pr-review label \
  --db /path/to/repo/.codegraph \
  --dry-run

# Override auto-detected GitHub repo:
codegraph pr-review prepare \
  --db /path/to/repo/.codegraph \
  --repo owner/repo

# Filter by author during prepare:
codegraph pr-review prepare \
  --db /path/to/repo/.codegraph \
  --author someone
```

> **Note:** You can also run via `python3 -m codegraph.pr_review prepare` or `python3 -m codegraph.pr_review label` with the same arguments if needed.

### Python API (for agents / scripts)

For programmatic use within the same Python process, use `PRReview`:

```python
from codegraph.pr_api import PRReview

# Full pipeline
with PRReview(db="/path/to/repo/.codegraph") as pr:
    pr.prepare()                   # fetch PRs → graph DB → scoring → report
    pr.label(dry_run=True)         # preview labels

# Query after prepare
with PRReview(db="/path/to/repo/.codegraph") as pr:
    conflicts = pr.conflict_prs_of("100")      # → ["101", "102"]
    risk      = pr.risk("100")                 # → {"risk_level": "HIGH", ...}
    groups    = pr.conflicting_groups()        # → [["100", "101"], ["103"]]
```

All queries return structured Python objects. The CLI and Python API
share the same implementation — prepare via CLI, query via Python works.

### CLI Arguments

**`codegraph pr-review prepare`:**

| Argument | Required | Description |
|----------|----------|-------------|
| `--db` | Yes | Path to the `.codegraph` database directory |
| `--repo` | No | GitHub repository in `owner/repo` format (auto-detected from `git remote`) |
| `--author` | No | Filter PRs by GitHub login |
| `--output` | No | Output directory for reports (default: `./pr_review_output`) |
| `--skip-single-pr` | No | Skip per-PR risk scoring; only cross-PR conflict analysis |

**`codegraph pr-review label`:**

| Argument | Required | Description |
|----------|----------|-------------|
| `--db` | Yes | Path to the `.codegraph` database directory |
| `--repo` | No | GitHub repository in `owner/repo` format (auto-detected from `git remote`) |
| `--dry-run` | No | Preview labels and comments without making API calls |

### Report Structure

The unified report (`pr_review.md`) has three sections:

1. **Part 1 — Auto-merge Candidates**: LOW risk, no interface/config changes, no cross-PR dependencies
2. **Part 2 — Independent Review**: Non-trivial PRs that can be reviewed independently (no function-level conflict)
3. **Part 3 — Conflicting PR Groups**: PRs sharing code/call paths, must be reviewed as a batch

Each PR entry includes:
- Risk level (CRITICAL/HIGH/MEDIUM/LOW/UNKNOWN) with emoji
- Impact scope (peak blast radius, clickable to call graph)
- Key risk factors
- Author and GitHub link

---

## How the analysis works

For each PR, the script computes signals at two levels.

### File-level signals

| Signal | How it's computed |
|---|---|
| **Changed files** | `gh pr diff --name-only`, filtered to source extensions (.ts/.tsx/.js/.jsx/.py/.java/.c/.cpp/.h/.go, excluding test files) |
| **Module spread** | Set of top-level `packages/xxx` directories touched |
| **Config/schema files** | File name matches common config patterns across languages (config.ts, settings.ts, settingsSchema.ts, types.ts, *.yaml, *.toml, *.cfg, etc.) |
| **Interface/abstract changes** | Diff lines starting with `+` that match `interface Foo` or `abstract class Foo` |
| **Potential dead code** | Functions in changed files that appear in `cs.dead_code()` (fan_in = 0 in graph) |

### Function-level signals (per function in changed files)

| Signal | How it's computed |
|---|---|
| **blast_radius** | `fan_in × fan_out` via Cypher CALLS edge counts |
| **call depth** | Fixed 1-hop and 2-hop queries from known entry points (`main`, `run`, `sendMessageStream`, etc.). Returns 1/2 if reachable, -1 if not. Variable-length path queries (`CALLS*1..N`) are intentionally avoided — they are expensive on large graphs. |
| **test coverage** | Graph CALLS from `.test.` files to this function, with filesystem fallback (same-stem `.test.ts` exists) |
| **new vs modified** | `locate_pr(pr_num)` — returns per-file `New Function` / `Hunk Function` / `Deleted Function` sets; functions in `Hunk Function - New Function` are classified as modified, the rest as new |
| **co-change risk** | `cs.co_change(func_name)` — historically co-changed files absent from PR. **Currently disabled** (`co_change_missing` weight = 0.0) |

### Per-PR confidence score

All signals are combined into a single risk score using configurable weights:

```python
WEIGHTS = {
    'blast_radius_norm':   3.0,   # normalized blast_radius (capped at 1.0 against threshold 50)
    'interface_change':    2.5,   # PR touches interface or abstract class
    'config_file':         1.0,   # PR touches config/schema files
    'cross_module':        0.0,   # [disabled] changes span multiple packages
    'modifies_existing':   1.0,   # modifies existing (not new) functions
    'no_test_coverage':    2.0,   # function has no test coverage
    'co_change_missing':   0.0,   # [disabled] historically co-changed file absent from PR
    'dead_code':           1.5,   # per function with fan_in = 0 after change
    'shallow_call_depth':  0.0,   # [disabled] function is within 2 hops of entry point
}
```

The PR score is the average per-function score plus file-level bonuses (interface change, config files, dead code count). Cross-module spread and shallow call depth are currently disabled (weight = 0.0).

### Risk level thresholds

| PR Risk Score | Level |
|---|---|
| ≥ 12 | CRITICAL |
| ≥ 7 | HIGH |
| ≥ 3 | MEDIUM |
| < 3 | LOW |

---

## Cypher query patterns

> Reference queries for the analytical operations used in the script.

**Functions in a changed file:**

```cypher
MATCH (f:Function)
WHERE f.file_path ENDS WITH 'src/core/client.ts'
  AND f.is_historical = 0
RETURN f.name, f.file_path, f.signature
LIMIT 50
```

**fan_in (callers of a function):**

```cypher
MATCH (caller:Function)-[:CALLS]->(f:Function)
WHERE f.name = 'myFunc'
  AND f.file_path ENDS WITH 'client.ts'
  AND f.is_historical = 0 AND caller.is_historical = 0
RETURN count(DISTINCT caller)
```

**fan_out (callees of a function):**

```cypher
MATCH (f:Function)-[:CALLS]->(callee:Function)
WHERE f.name = 'myFunc'
  AND f.file_path ENDS WITH 'client.ts'
  AND f.is_historical = 0 AND callee.is_historical = 0
RETURN count(DISTINCT callee)
```

**Direct callers (hop-1):**

```cypher
MATCH (caller:Function)-[:CALLS]->(f:Function {name: 'myFunc'})
WHERE f.is_historical = 0 AND caller.is_historical = 0
RETURN DISTINCT caller.name, caller.file_path
LIMIT 30
```

**Interface implementors (TypeScript `implements` → `INHERITS` edge):**

```cypher
MATCH (impl:Class)-[:INHERITS]->(iface:Class {name: 'MyInterface'})
RETURN impl.name, impl.file_path
```

---

## stdout Tee pattern (write to file and terminal simultaneously)

```python
import sys

OUTPUT_FILE = '/tmp/pr_analysis.txt'

with open(OUTPUT_FILE, 'w') as fout:
    original_stdout = sys.stdout

    class Tee:
        def write(self, data):
            original_stdout.write(data)
            fout.write(data)
        def flush(self):
            original_stdout.flush()
            fout.flush()
    sys.stdout = Tee()
    try:
        run_all_analyses()
    finally:
        sys.stdout = original_stdout
```

---

## Graph-Based Cross-PR Analysis (`CrossPRAnalyzer`)

`pr_review.py` is the authoritative unified pipeline. For graph-native cross-PR queries alone, use `CrossPRAnalyzer` from `pr_analysis.py`: it **writes PR function sets directly into the CG graph** as `PR` nodes (with flat properties: `id`, `title`, `author`, `risk_level`, `label`) and `CHANGES` edges, then uses Cypher to query cross-PR relationships.

### Conflict Detection Dimensions

Cross-PR conflicts are detected at three levels of granularity:

| Level | What it detects | How it's detected |
|-------|----------------|-------------------|
| **File-level overlap** | Two PRs modify the same file | Set intersection of `gh pr diff --name-only` results |
| **Function-level overlap** | Two PRs modify the same function (even different lines) | `CHANGES {info: 'hunk'}` edges to the same `Function` node — this powers the automated connected-components detection |
| **Dependency chain overlap** | PR A modifies function X, PR B modifies function Y, and Y calls X — git reports no conflict but merging A may break B's assumptions | Cypher: `MATCH (pr1:PR)-[c1:CHANGES]->(f:Function)-[:CALLS]->(g:Function)<-[c2:CHANGES]-(pr2:PR)` — see usecase3 (manual) queries below |

### When to Use

- You want to interactively explore cross-PR call relationships via Cypher
- You want to include **Related Functions** (callers of hunk functions) in cross-PR analysis, not just the directly modified functions
- You want the graph to persist across sessions for later querying

### Setup: Write PR Functions into the Graph

Run once per batch of PRs to analyze. `prepare()` always deletes all existing `PR` nodes and `CHANGES` edges before inserting the current batch — PR nodes are temporary (they represent unmerged branches), so stale entries from a prior run must be cleared each time. After `--label` analysis, `update_pr_labels()` persists the computed labels (e.g. `auto-merge-candidate`, `conflicting-group-N`) to the `pr.label` column in the graph DB, enabling offline queries without re-running analysis.

```python
import os
os.environ['HF_HUB_OFFLINE'] = '1'
from codegraph.core import CodeScope
from codegraph.pr_analysis import CrossPRAnalyzer

DB_DIR = '/path/to/repo/.codegraph'  # adjust to your repo
REPO_DIR = '/path/to/repo'           # local git repo path
cs = CodeScope(DB_DIR)
cross = CrossPRAnalyzer(cs, repo_dir=REPO_DIR)

prs = ['2585', '2584', '2583', '2582', '2581', '2580']  # PR numbers to analyze
cross.prepare(prs)
cs.close()
```

Internally, `prepare()` calls `_write_pr_graph_nodes(pr_id)` for each PR, which:

1. Runs `resolve_pr_functions` (from `pr_locator.py`) to categorize PR functions against the graph DB
2. **Hunk**: PR modified this function — confirmed in graph DB by `name + file_path` match → `(PR)-[:CHANGES {info:'hunk'}]->(Function)`
3. **Deleted**: PR deleted this function — confirmed in graph DB by `name + file_path` match → `(PR)-[:CHANGES {info:'deleted'}]->(Function)`
4. **Related**: PR newly calls this function — confirmed in graph DB by `name` match → `(PR)-[:CHANGES {info:'related'}]->(Function)`
5. **New**: PR added this function — not yet in graph DB (no pre-confirmation needed) → `(PR)-[:CHANGES {info:'new'}]->(Function)`

This graph-DB-verified insertion is what distinguishes cross-PR analysis from `PRScorer`'s blast-radius scoring — only functions confirmed in the index are included for hunk/deleted/related; new functions are recorded even if not yet indexed.

### Three Query Dimensions

```python
from codegraph.pr_analysis import CrossPRAnalyzer
cross = CrossPRAnalyzer(cs, repo_dir=REPO_DIR)
rows1, rows2, components = cross.analyze_all(out_dir='/tmp')
```

| Usecase | What it finds | When to use |
|---------|--------------|-------------|
| **usecase1** PR → hunk functions | All functions directly modified by each PR; rendered as vis-network HTML | Quick inventory |
| **usecase2** hunk + fan-in callers | Who calls each modified function (1-hop upstream); rendered as 2-hop vis-network HTML | Blast-radius exposure per PR |
| **usecase3** Connected Components (DSU) | Groups of PRs linked by modifying or deleting the same function | Identifies conflicting PR groups requiring coordinated review |

### Cypher Queries

```cypher
-- usecase1: PR → hunk functions
MATCH (pr:PR)
OPTIONAL MATCH (pr)-[r:CHANGES]->(f:Function)
WHERE r.info = 'hunk'
RETURN pr.id, pr.title, pr.risk_level, pr.label, f.name, f.file_path;

-- usecase2: hunk functions + upstream callers (1-hop fan-in)
MATCH (pr:PR)
OPTIONAL MATCH (pr)-[r:CHANGES]->(f:Function)
WHERE r.info = 'hunk'
OPTIONAL MATCH (f)<-[c:CALLS]-(g:Function)
RETURN pr.id, f.name, g.name, g.file_path;

-- Query PR labels (after --label has been run):
MATCH (pr:PR)
WHERE pr.label <> ''
RETURN pr.id, pr.title, pr.label
ORDER BY pr.label;

-- usecase3 (active): same function modified/deleted by 2 PRs — powers the automated CC detection
MATCH (pr1:PR)-[c1:CHANGES]->(f:Function)<-[c2:CHANGES]-(pr2:PR)
WHERE c1.info IN ['hunk','deleted'] AND c2.info IN ['hunk','deleted'] AND pr1.id < pr2.id
RETURN pr1.id, pr2.id;

-- usecase3 (manual): direct CALLS between modified functions of different PRs
MATCH (pr1:PR)-[c1:CHANGES]->(f:Function)-[:CALLS]->(g:Function)<-[c2:CHANGES]-(pr2:PR)
WHERE c1.info = 'hunk' AND c2.info = 'hunk' AND pr1 <> pr2
RETURN pr1.id, pr2.id;

-- usecase3 (manual): shared caller of functions modified by different PRs
MATCH (pr1:PR)-[c1:CHANGES]->(f:Function)<-[call1:CALLS]-(middle:Function)-[call2:CALLS]->(g:Function)<-[c2:CHANGES]-(pr2:PR)
WHERE c1.info = 'hunk' AND c2.info = 'hunk' AND pr1.id < pr2.id AND f <> g AND call1 <> call2
RETURN pr1.id, pr2.id;
```

### Interpreting usecase3 Results

| Connected Component Size | Meaning | Recommended action |
|--------------------------|---------|-------------------|
| Size 1 (singleton) | PR has no cross-PR dependencies | Can be reviewed and merged independently |
| Size > 1 | PRs in the same component share code or call paths | Review as a batch; see `pr_review.py` Part 3 report |

---

## Index location

- Index directory: `.codegraph/` (repo root, add to `.gitignore`)
- Default output: `/tmp/pr_analysis.txt` (configurable)

