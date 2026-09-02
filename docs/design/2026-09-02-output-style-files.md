# Custom output style files

Follow-up to the built-in styles (#9565, #10282), the `general.outputStyle`
setting and `--output-style` flag (#10283), and the `/output-style` picker
(#10683). Those slices left `OutputStyleSource` with `user`, `project` and
`extension` members that nothing populated. This slice populates the first two.

## What a style file is

A Markdown file in `~/.qwen/output-styles/` or `<project>/.qwen/output-styles/`.
The body is the prompt section; an optional YAML frontmatter carries `name`,
`description` and `keep-coding-instructions`. Every field has a default (file
name, first body line, `false`), so a bare Markdown file is a valid style.
The keys are kebab-case on purpose: they are the keys a style file written for
other CLI agents already uses, so one file works in both.

## Decisions

- **Only two directories, top level only.** No policy/managed level, no
  additional-directory scan, no recursion. Each of those is a separate
  decision with its own trust story; none is needed to make the feature
  useful. The loader takes a directory and a source label, so more levels
  are one call each if they ever land.
- **Project files require a trusted workspace.** A checked-in style file is a
  prompt. The CLI passes the project root to the catalog only when
  `isWorkspaceTrusted` says so, and the command does the same through
  `config.isTrustedFolder()`. This is the same line the workspace
  `settings.json` already draws.
- **`--bare` and `--safe-mode` keep the built-ins.** Both modes already ignore
  the setting and refuse `/output-style`; the catalog is never read there, so a
  broken file cannot affect a diagnostic run.
- **Precedence project > user > built-in, by case-insensitive name.** Mirrors
  `SkillManager`. A custom file may shadow a built-in name; a user who names a
  file `concise.md` gets their file, which is the least surprising outcome
  and matches how skills behave.
- **`keep-coding-instructions` defaults to `false` for a file.** The built-ins
  are all coding styles and set it to `true`; a file is assumed to describe
  something else until it says otherwise. The section it drops is exactly the
  software-engineering workflow guidance; safety rules and tool guidance stay.
- **Re-read on use, no cache, no watcher.** The catalog is read at startup
  (to resolve the setting or flag), when the picker opens, and when a name
  is given to `/output-style`. Two small directory reads are cheap, and it
  means adding a file needs no restart. A hand edit to the _active_ style's
  file still needs a re-select, since the prompt is only rebuilt on apply.
- **Bad files are skipped, not fatal.** Empty body, reserved or malformed
  name, or a file over 1 MiB is logged to the debug log and the rest load.
  Startup already applies the no-lockout rule to an unknown setting value.
- **The picker resolves against the list it showed.** The hook keeps the
  catalog it loaded when opening; the selection is resolved against that
  list, not a fresh read, so a file removed between open and select yields a
  clear error rather than a silent no-op.

## Out of scope

- Extension-bundled styles (`source: 'extension'`), including the
  `outputStyles` manifest field the Claude-plugin converter currently
  warns about. Next slice.
- A settings-file watcher applying a hand-edited `general.outputStyle`
  mid-session.
