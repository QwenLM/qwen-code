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

Auto-memory files live at `~/.qwen/projects/<project>/memory/`. All branches and worktrees of the same repository share the same memory folder, so what Qwen learns in one branch is available in others.

Everything saved is plain markdown — you can open, edit, or delete any file at any time.

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
