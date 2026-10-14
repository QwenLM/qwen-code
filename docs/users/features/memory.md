# Memory

Every Qwen Code session starts with a fresh context window. Two mechanisms carry knowledge across sessions so you don't have to re-explain yourself every time:

- **QWEN.md** — instructions _you_ write once and Qwen reads every session
- **Auto-memory** — notes Qwen writes itself based on what it learns from you

---

## QWEN.md: your instructions to Qwen

QWEN.md is a plain text file where you write things Qwen should always know about your project or your preferences. Think of it as a permanent briefing that loads at the start of every conversation.

### What to put in QWEN.md

Add things you'd otherwise have to repeat every session:

- Build and test commands (`npm run test`, `make build`)
- Coding conventions your team follows ("all new files must have JSDoc comments")
- Architectural decisions ("we use the repository pattern, never call the database directly from controllers")
- Personal preferences ("always use pnpm, not npm")
- A verification policy for high-stakes work — for example "verify against the database before concluding" (see [Enforce evidence-based conclusions](../common-workflow.md#enforce-evidence-based-conclusions) for a ready-made template)

Don't include things Qwen can figure out by reading your code. QWEN.md works best when it's short and specific — the longer it gets, the less reliably Qwen follows it.

### Where to create QWEN.md

| File                          | Who it applies to                                |
| ----------------------------- | ------------------------------------------------ |
| `~/.qwen/QWEN.md`             | You, across all your projects                    |
| `QWEN.md` in the project root | Your whole team (commit it to source control)    |
| `.qwen/QWEN.local.md`         | Only you, only in this project (keep out of git) |

You can have any combination of these. Qwen loads all of them when you start a session.

If your repository already has an `AGENTS.md` file for other AI tools, Qwen reads that too. No need to duplicate instructions.

#### When to use `.qwen/QWEN.local.md`

Use it for **project-specific but personal** instructions — things that belong to this project but shouldn't be shared with the team:

- Your own cluster ID, container registry namespace, or cloud account
- A personal debug command that hardcodes your local environment
- Notes you want Qwen to know about your work-in-progress, but not commit

It loads **after** the shared project `QWEN.md`, so your local instructions can supplement or override the team's.

**You must gitignore it yourself.** Although `.qwen/` is often treated as a local directory, qwen-code does not generate a `.gitignore` for you, and some projects commit `.qwen/settings.json`. Add this line to your `.gitignore` (or to your global git ignore):

```
.qwen/QWEN.local.md
```

### Generate one automatically with `/init`

Run `/init` and Qwen will analyze your codebase to create a starter QWEN.md with build commands, test instructions, and conventions it finds. If one already exists, it suggests additions instead of overwriting.

### Reference other files

You can point QWEN.md at other files so Qwen reads them too:

```markdown
See @README.md for project overview.

# Conventions

- Git workflow: @docs/git-workflow.md
```

Use `@path/to/file` anywhere in QWEN.md. Relative paths resolve from the QWEN.md file itself.

---

## Auto-memory: what Qwen learns about you

Auto-memory runs in the background. After each of your conversations, Qwen quietly saves useful things it learned — your preferences, feedback you gave, project context — so it can use them in future sessions without you repeating yourself.

This is different from QWEN.md: you don't write it, Qwen does.

### What Qwen saves

Qwen looks for four kinds of things worth remembering:

| What                    | Examples                                                 |
| ----------------------- | -------------------------------------------------------- |
| **About you**           | Your role, background, how you like to work              |
| **Your feedback**       | Corrections you made, approaches you confirmed           |
| **Project context**     | Ongoing work, decisions, goals not obvious from the code |
| **External references** | Dashboards, ticket trackers, docs links you mentioned    |

Qwen doesn't save everything — only things that would actually be useful next time.

### Where it's stored

Auto-memory files live at `~/.qwen/projects/<project>/memory/`. All branches of the same checkout share the same memory folder, so what Qwen learns in one branch is available in others. Each linked git worktree gets its own memory folder, matching the per-worktree isolation of chats and other session state — repository-wide conventions you want in every worktree belong in [team memory](#team-memory-shared-with-collaborators).

Everything saved is plain markdown — you can open, edit, or delete any file at any time.

`MEMORY.md` is a compact index, rather than the full memory store. Its generated body and the portion loaded into prompts share a limit of 200 lines and 25,000 UTF-16 code units; truncation notices are added separately. Line endings are normalized before prompt budgeting. Under size pressure, complete ordinary entries (up to 150 code units) get space before longer entries, and retained entries keep their original order. An entry that cannot fit is skipped whole, so its Markdown link is never cut in the middle. Keep detail in the linked topic files.

#### Pinned memory

Put hand-curated documents that automatic memory maintenance should preserve
under `pinned/` in a managed-memory directory, for example
`~/.qwen/projects/<project>/memory/pinned/architecture.md` or
`~/.qwen/memories/pinned/preferences.md`. Use the same frontmatter as other
memory documents. Valid pinned files are readable by Qwen and are included the
next time `MEMORY.md` is rebuilt, under the same size and file-count limits as
other memory documents.

Only the top-level `pinned/` directory directly inside a managed-memory root is
protected; nested directories such as `memory/project/pinned/` are ordinary
writable memory. Automatic extraction and Dream workers match the reserved
directory name case-insensitively.

Automatic extraction is instructed to leave pinned records and their valid
index entries unchanged, while Dream is instructed to skip `pinned/` during
consolidation. Both automatic extraction and forked Dream workers, including
background cleanup, enforce the pinned-file boundary on their write and edit
tools, including paths that resolve through a symlink into `pinned/`.
Command-line deletion is closed off too: only the project Dream worker holds a
shell, and its policy is read-only, while automatic extraction and the
user-memory Dream worker hold no shell at all. You still control
these files directly and can remove them with an explicit `/forget` request.

> **Note:** The visible `/dream` slash command runs on the main Agent. It
> receives the same skip instruction, but does not yet receive the forked
> worker's deterministic per-turn tool gate.

### Periodic cleanup

Qwen periodically goes through its saved memories to remove duplicates and clean up outdated entries. This runs automatically in the background once a day after enough sessions have accumulated. You can trigger it manually with `/dream` if you want it to run now.

Your session continues normally while cleanup runs in the background.

### Turning it on or off

Auto-memory is on by default. To toggle it, open `/memory` and use the switches at the top. You can turn off just the automatic saving, just the periodic cleanup, or both.

You can also set them in `~/.qwen/settings.json` (applies to all projects) or `.qwen/settings.json` (this project only):

```json
{
  "memory": {
    "enableManagedAutoMemory": true,
    "enableManagedAutoDream": true
  }
}
```

### Structured recall (opt-in)

By default Qwen reads memory as a flat `MEMORY.md` index. The structured protocol replaces that with a hierarchical memory tree, injects only the subtree relevant to your current request, and gives Qwen a `search_memory` tool to pull full entries on demand — which costs fewer tokens once a memory collection grows past a handful of files.

It is off by default. Turn it on in `settings.json` (restart required):

```json
{
  "memory": {
    "enableStructuredRecall": true
  }
}
```

or for a single run with `QWEN_CODE_MEMORY_STRUCTURED_RECALL=1`.

Turning it on starts a background metadata migration: each memory file gains the frontmatter (category, keywords, usage scenarios) that recall needs. It runs in small batches of at most 10 files per turn and only rewrites frontmatter, never the body of a note. While the setting is off the migration is never scheduled, so nothing is rewritten and no background model calls are made.

### Team memory (shared with collaborators)

By default, auto-memory is **private to you** — it lives under your home directory and is never shared. Team memory is an opt-in tier that the whole team shares **through git**.

When enabled, Qwen gains a third memory directory at `.qwen/team-memory/` **inside the repository**. It uses the same one-file-per-memory layout and `MEMORY.md` index as the private tiers. Because it is committed to the repo, it is shared with every collaborator the normal way: you `git pull` to receive teammates' memories and commit/push to share yours. Qwen routes durable, project-wide knowledge here — conventions every contributor must follow, shared reference pointers (trackers, dashboards) — while personal and fast-decaying notes stay private.

Enable it per project (or globally) in `settings.json`:

```json
{
  "memory": {
    "enableTeamMemory": true
  }
}
```

It is **off by default**. Keep these caveats in mind:

- **It is source-controlled and visible to everyone with repo access.** Treat a team memory like committing to the repo.
- **Secrets are blocked.** Writes to `.qwen/team-memory/` are scanned for credentials (API keys, tokens, private keys); a detected secret is rejected, never written. The scan is a backstop, not a guarantee — don't put sensitive data there.
- **Changes are reviewable.** Team memory writes appear in `git status` / the PR diff like any other file, so they can be reviewed before they're committed. In the default approval mode Qwen also asks before each team write; in `AUTO_EDIT`/YOLO mode (where you've opted into auto-approval) they are applied without a prompt but still surface in the diff.
- **The directory must be git-tracked.** If your project's `.gitignore` excludes `.qwen/*`, re-include the path so it can be shared:

  ```gitignore
  !.qwen/team-memory/
  !.qwen/team-memory/**
  ```

  Caveat: use the file-glob ignore form (`.qwen/*`), not a directory form with a trailing slash (`.qwen/`). A directory-form ignore makes git skip the folder entirely, so a `!`-reinclude below it is a no-op and the team tier stays silently empty in git. Qwen warns once at startup when the tier is enabled but its directory is git-ignored or outside any git repository, so this misconfiguration does not pass unnoticed.

`QWEN_CODE_MEMORY_TEAM=1` / `=0` overrides the setting for a single run.

### Automatic git sync (optional)

By default you share team memory with the normal git workflow (`pull` to receive, `commit`/`push` to share). To have Qwen do it for you, enable sync:

```json
{
  "memory": {
    "enableTeamMemory": true,
    "enableTeamMemorySync": true
  }
}
```

When on, at session start Qwen best-effort syncs the `.qwen/team-memory/` directory: it rebuilds the shared `MEMORY.md` index, fast-forward-pulls collaborators' updates **first**, then commits your team-memory changes on top, and pushes **only that sync commit** (via an explicit single-branch refspec) — so the index you load reflects the latest. It only **stages** the team directory (your other working changes are never committed), and never blocks the session on a git failure. Off by default. `QWEN_CODE_MEMORY_TEAM_SYNC=1` / `=0` overrides the setting for a single run.

Two things to know before enabling it:

- **The fast-forward pull acts on your whole current branch, not just `.qwen/team-memory/`** (git has no path-scoped pull). So sync will fast-forward your branch to the remote tip. The push, by contrast, is scoped: it publishes **only the commit this sync just created**, so it never pushes other unpushed commits you have — if your branch is already ahead of upstream, sync commits locally and skips the push. Enable it on branches where the fast-forward pull is fine — or run it on a dedicated checkout.
- **A diverged branch is left untouched** (`--ff-only` never merges). When that happens sync simply does nothing that session; resolve the divergence (`git pull`) and it resumes. A branch with no upstream (no tracking configuration) still commits locally but skips the push — there is nowhere to push to.

---

## Commands

### `/memory`

Opens the Memory panel. From here you can:

- Turn auto-memory saving on or off
- Turn periodic cleanup (dream) on or off
- Open your personal QWEN.md (`~/.qwen/QWEN.md`)
- Open the project QWEN.md
- Browse the auto-memory folder

### `/memory migrate-team`

Migrates the **team memory** tier (`.qwen/team-memory/`) to the structured metadata format: each file gains the frontmatter (name, description, category, keywords, usage scenarios) that memory recall needs. Personal and project memory are migrated automatically in the background once [structured recall](#structured-recall-opt-in) is enabled; team memory is shared through git, so the rewrite runs only on explicit request and shows up as a reviewable commit. Run it once per repository in a trusted workspace with team memory enabled.

### `/init`

Generates a starter QWEN.md for your project. Qwen reads your codebase and fills in build commands, test instructions, and conventions it discovers.

### `/remember <text>`

Immediately saves something to auto-memory without waiting for Qwen to pick it up automatically:

```
/remember always use snake_case for Python variable names
/remember the staging environment is at staging.example.com
```

### `/forget <text>`

Removes auto-memory entries that match your description:

```
/forget old workaround for the login bug
```

### `/dream`

Runs the memory cleanup now instead of waiting for the automatic schedule:

```
/dream
```

---

## Import selected Codex memories

Use the offline import command to preview existing Codex memories without starting a model session:

```bash
qwen memory import codex --dry-run
qwen memory import codex --source /path/to/codex/memories --dry-run --json
```

The default source is `$CODEX_HOME/memories`, or `~/.codex/memories` when `CODEX_HOME` is unset. With no `--select`, an interactive terminal opens review and lets you confirm importing; non-interactive commands only preview. `--dry-run` never writes memory files, indexes, import records, or locks, even when IDs are selected. Preview output and any full-text review snapshots contain private memory text; keep them out of repositories, shared logs, and PRs.

The preview shows candidate IDs, text, source locations, destination directories, and status. It reads recognized user-profile and preference sections in `memory_summary.md`, and preference, reusable-knowledge, and lessons sections in `MEMORY.md`. These are candidates for your review, not automatic assertions that historical information is still correct. It does not import transcripts, rollout summaries, or skills.

### Review in the terminal

In an interactive terminal, previews open a browser with three views: groups, entries, and detail. Resolved project entries are grouped by memory destination and labeled with their resolved main project; user memory has its own group. Entries without a reliable project destination appear in a separate `User memory (global fallback)` group. Their list labels explicitly mark the global fallback; details and full text show the reason and any original project path. All eligible `ready` and `duplicate` candidates, including global fallbacks, are selected by default. Conflicts, blocked entries, and previously imported entries are excluded. Counts and status totals help you choose what to review first. Supplemental source notes and warnings share one `Source notes & warnings` review group.

| Key                  | Action                                                                     |
| -------------------- | -------------------------------------------------------------------------- |
| `↑` / `↓`, `j` / `k` | Move through a list.                                                       |
| `Enter`              | Open the focused group or item.                                            |
| `Space`              | Toggle an eligible candidate or all eligible entries in the focused group. |
| `Esc`                | Go back one view; cancel from the groups view.                             |
| `d`                  | Close a dry-run preview; otherwise open import confirmation (same as `i`). |
| `i`                  | Start import confirmation (unavailable during `--dry-run`).                |
| `a` / `n`            | Select all eligible entries / clear all selections.                        |
| `o`                  | Open the focused entry, source note, or warning from a list or detail.     |

Selections remain checked when you move between groups. Other statuses, source notes, and warnings are readable but cannot be selected for import. Long details show a truncation notice; use `o` to read the complete text in the platform's default editor.

The `o` action creates a private temporary review copy outside your repositories and memory directories. A temporary location inside the source, a native memory directory, or any Git checkout is rejected before the copy is created. It never opens the original source for editing, and changes to the copy do not affect the preview or any memory. Keep the preview open while reading the copy; review copies are removed when the preview closes. If the editor or temporary file cannot be opened, the preview reports the error and remains usable. Browsing, selecting, and closing without import confirmation or `o` create no files.

To import interactively, run `qwen memory import codex` without `--dry-run` or `--select`. Review the default selection, press `i`, and choose **Import** in the confirmation (the initial choice is **Back to review**). The summary lists project/user counts and global fallbacks; if source amendment notes exist, the import action explicitly acknowledges reviewing them. `--dry-run` always stays read-only: close it and restart without those options to import. `--json` returns complete JSON, and redirected or non-interactive input/output keeps plaintext; without explicit IDs these modes only preview. These modes do not open the browser. The preview does not start a model session or make network requests.

### Resolve projects and apply selected entries

Global summary preferences go to user memory. Handbook entries, including project-specific feedback, stay project-scoped when an unambiguous project directory can be resolved. Otherwise the entry becomes a clearly marked global candidate; it is never silently assigned to the current project. If a known source project moved, supply an explicit mapping:

```json
{
  "/old/projects/atlas": "/new/projects/atlas"
}
```

Save the mapping outside your repository and preview it with `--project-map /path/to/project-map.json`. A mapping can keep a known moved project project-scoped instead of using the global fallback. Destinations follow native runtime and project-scope settings; imports into repository-local memory or any Git checkout are refused. Team memory is never a destination.

For Codex imports, a verified Git worktree or repository subdirectory resolves to the main checkout before applying native runtime and memory settings. Exact mappings are applied first, so a mapping to a worktree also resolves to its main project. The preview preserves the original `sourceProject` and displays `resolvedProject`; entries from the same main project share a group, destination, duplicate checks, and conflict checks. Separate clones and submodules remain separate projects; non-Git directories keep their explicit scope. This import rule does not change Qwen's usual per-worktree memory recall.

Unverifiable Git metadata, bare repositories, unsupported linked-worktree layouts, and missing project directories produce global fallback candidates with an explanation. Repair metadata or map the exact source path to an existing main checkout to keep those entries project-scoped. The importer never guesses repositories from directory names or remotes.

An explicit `cwd` can include supplemental worktree, source-reference, or branch annotations: `cwd=/work/atlas and worktree=/work/atlas-feature` still belongs to `/work/atlas`. Backtick-quote paths containing scope delimiters such as commas or parentheses. Quoted or unquoted branch annotations are accepted. Named worktrees remain associated with the primary cwd; `or atlas worktree` is treated as the same project only when `atlas` exactly matches the cwd basename. A parenthesized `rollout metadata cwd=...` is historical provenance, not a second primary project. Other multiple scopes, conflicting primary cwd values, wildcards, and unsupported annotations become global fallback candidates.

JSON exposes the effective `scope` (`user` or `project`). For global fallback candidates, `scopeReason` explains why project ownership could not be established; it remains visible even if `reason` later reports a duplicate or conflict. Global fallback makes the selected memory available across projects, so review its applicability before confirming the default selection. Fallback entries are clearly labeled and counted separately in the confirmation; they are never written just by opening the preview. Credential blocks, unsafe destinations, source-reading failures, and invalid ledgers are not bypassed by fallback.

For scripted import, review the text and destinations, then supply specific IDs:

```bash
qwen memory import codex --source /path/to/codex/memories --select <candidate-id>
```

If the source has supplemental `extensions/ad_hoc/notes/*.md` files, the preview includes them as review material. They may amend or delete information in the handbook. Resolve their meaning while selecting entries; the importer cannot interpret arbitrary prose deletion requests. Scripted import also requires `--review-source <sourceDigest>` from the unchanged preview. Interactive import supplies the displayed digest after you confirm that the notes have been reviewed. A changed source requires a fresh preview and review.

| Status                | Meaning                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ready`               | Can be imported when explicitly selected.                                                                               |
| `duplicate`           | Exact normalized content is already present or repeated in this batch.                                                  |
| `conflict`            | An imported source/document changed, or a destination/title already exists with different content. No overwrite occurs. |
| `previously-imported` | Already handled; missing documents are not recreated after forgetting or consolidation.                                 |
| `blocked`             | A known credential pattern was detected; content is redacted.                                                           |
| `imported`            | The selected new native document was written.                                                                           |

Deduplication uses normalized exact text within each destination; it is not semantic contradiction detection. Selecting a conflict or blocked entry stops the import before memory writes. Existing topic files are never overwritten. Known source update times are preserved; unknown source dates are labeled unknown.

The private `.codex-import.json` ledger remains after Qwen edits, consolidates, or forgets imported notes. Do not delete it when cleaning up memory: it prevents a later import from restoring forgotten content. The importer reserves entries before creating documents; an interrupted import may leave a reserved entry requiring manual inspection instead of automatically retrying it. A `.codex-import.lock` prevents concurrent imports; remove a leftover lock only after confirming that no import is running. Index generation follows the existing native limits.

Candidate IDs remain stable for text edits within the same slot. Changing headings or inserting/reordering entries may change IDs or produce conservative conflicts; preview again after reorganizing the source.

Import is a one-time snapshot. Codex continues to own its source files, and Qwen owns imported copies. There is no automatic synchronization or overwrite of later Qwen corrections.

---

## Troubleshooting

### Qwen isn't following my QWEN.md

Open `/memory` to see which files are loaded. If your file isn't listed, Qwen can't see it — make sure it's in the project root or `~/.qwen/`.

Instructions work better when they're specific:

- ✓ `Use 2-space indentation for TypeScript files`
- ✗ `Format code nicely`

If you have multiple QWEN.md files with conflicting instructions, Qwen may behave inconsistently. Review them and remove any contradictions.

### I want to see what Qwen has saved

Run `/memory` and select **Open auto-memory folder**. All saved memories are readable markdown files you can browse, edit, or delete.

### Qwen keeps forgetting things

If auto-memory is on but Qwen doesn't seem to remember things across sessions, try running `/dream` to force a cleanup pass. Also check `/memory` to confirm both toggles are enabled.

For things you always want Qwen to remember, add them to QWEN.md instead — auto-memory is best-effort, QWEN.md is guaranteed.
