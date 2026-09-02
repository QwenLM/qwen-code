# Custom Output Style Files

## Goal

Confirm that a style file in `~/.qwen/output-styles/` or the project's
`.qwen/output-styles/` is offered by `/output-style`, applies to the running
session, survives a restart through `general.outputStyle`, and is refused in
the cases the design excludes (untrusted workspace, `--safe-mode`).

## Baseline

Run the global `qwen` first: `/output-style` lists only the four built-ins and
`/output-style reviewer` reports an unknown style. The scenarios below must
change that.

## Fixtures

```bash
mkdir -p ~/.qwen/output-styles .qwen/output-styles
cat > ~/.qwen/output-styles/reviewer.md <<'EOF'
---
name: Reviewer
description: Reviews code and reports findings without editing anything
---
You are reviewing, not implementing. List concrete findings ordered by severity and never edit files unless asked.
EOF
cat > .qwen/output-styles/haiku.md <<'EOF'
Answer every question as a haiku. Keep it to three lines.
EOF
cat > .qwen/output-styles/broken.md <<'EOF'
---
name: default
---
This file must be skipped.
EOF
```

## Scenarios

1. **Picker lists custom styles.** `npm run dev`, then `/output-style`. Expect
   the four built-ins followed by `Reviewer — … (user)` and
   `haiku — Answer every question as a haiku. … (project)`. No `broken` entry.
2. **Project style applies now.** Select `haiku`. Expect
   `Output style set to haiku.` and `~/.qwen/settings.json` to contain
   `"outputStyle": "haiku"`. Ask "what does package.json do?" and expect a
   three-line answer.
3. **Name argument, case-insensitive.** `/output-style REVIEWER`. Expect
   `Output style set to Reviewer.`
4. **New file without restart.** With the session still open, add
   `.qwen/output-styles/terse.md` containing `One sentence only.` then run
   `/output-style` again. Expect `terse` in the list.
5. **Unknown name lists custom styles.** `/output-style nope`. Expect the
   error to list `Concise, Proactive, Explanatory, Learning, Reviewer, haiku,
   terse`.
6. **Persists across restart.** Exit, start again, ask a question. Expect a
   haiku (or the last selected style) with no `/output-style` call.
7. **Safe mode keeps built-ins.** `npm run dev -- --safe-mode`. Expect no
   custom style applied and `/output-style` to refuse.
8. **Untrusted workspace.** In a folder not trusted under
   `security.folderTrust`, expect the picker to show `Reviewer` but not
   `haiku`.

## Cleanup

```bash
rm -rf .qwen/output-styles ~/.qwen/output-styles/reviewer.md
```

Restore `general.outputStyle` in `~/.qwen/settings.json` to its prior value.
