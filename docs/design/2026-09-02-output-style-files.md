# Custom output style files

Follow-up to the built-in styles (#9565, #10282), the `general.outputStyle`
setting and `--output-style` flag (#10283), and the `/output-style` picker
(#10683). Those slices left `OutputStyleSource` with `user`, `project` and
`extension` members that nothing populated. This slice populates the first two.

## What a style file is

A Markdown file in `~/.qwen/output-styles/` or `<project>/.qwen/output-styles/`.
The body is the prompt section; an optional YAML frontmatter carries `name`,
`description` and `keep-coding-instructions`. Every field has a default (file
name, first body line, the shadowed built-in's value or `false`), so a bare
Markdown file is a valid style. The keys are kebab-case on purpose: they are
the keys a style file written for other CLI agents already uses, so one file
works in both.

## Decisions

- **Only two directories, top level only.** No policy/managed level, no
  additional-directory scan, no recursion. Each of those is a separate
  decision with its own trust story; none is needed to make the feature
  useful. The loader takes a directory and a source label, so more levels
  are one call each if they ever land.
- **Project files require a trusted workspace, on both sides.** A checked-in
  style file is a prompt. The CLI passes the project root to the catalog only
  when `isWorkspaceTrusted` says so, and the command does the same through
  `config.isTrustedFolder()`. The gate is re-checked where the style is
  consumed, not only where it is read, so revoking trust mid-session (the IDE
  companion changes the verdict in place, without a restart) drops a project
  style from the prompt instead of leaving it embedded for the rest of the
  session.
- **A style file may only read itself.** The body goes into the system prompt
  verbatim, so a link is an exfiltration vector: a project file must not be a
  symlink at all, a user file may be one (a dotfiles setup is ordinary) but
  its target must stay inside the user's own root, both levels refuse a hard
  link, and both confine the canonical path so a symlinked ancestor is caught
  too. This mirrors `readLoopTaskFile`, which guards the identical sink.
- **`--bare` and `--safe-mode` keep the built-ins.** Both modes already ignore
  the setting and refuse `/output-style`; the catalog is never read there, so a
  broken file cannot affect a diagnostic run.
- **Precedence project > user > built-in, by case-insensitive name.** Mirrors
  `SkillManager`. A custom file may shadow a built-in name; a user who names a
  file `concise.md` gets their file, which is the least surprising outcome
  and matches how skills behave.
- **`keep-coding-instructions` defaults to what the file shadows.** A file
  that declares nothing and shadows a built-in inherits that built-in's value,
  so rewriting `concise.md` changes the wording without silently deleting the
  software-engineering guidance the built-in carries. A file with no built-in
  counterpart defaults to `false`: it is assumed to describe something else
  until it says otherwise. The section it drops is exactly the
  software-engineering workflow guidance; safety rules and tool guidance stay.
- **The name in the prompt is the definition's, not the file's.** The headless
  `Learning` rule keys on the built-in definition, so a user's own
  `Learning.md` is not dropped from headless runs by a name collision.
- **Arena peers do not inherit a presentation style blindly.** A peer is a
  fresh headless coding agent: it follows the same prompt-override and headless
  rules the main session does, and it never inherits a style that drops the
  coding instructions its own job depends on.
- **Re-read on use, no cache, no watcher.** The catalog is read at startup
  (to resolve the setting or flag), when the picker opens, and when a name
  is given to `/output-style`. Two small directory reads are cheap, and it
  means adding a file needs no restart. A hand edit to the _active_ style's
  file still needs a re-select, since the prompt is only rebuilt on apply.
- **Bad files are skipped, not fatal.** Empty body, reserved or malformed
  name, a non-text (UTF-16 or binary) file, or a file over the size bound is
  logged to the debug log and the rest load. The bound is the house bound for
  file text injected into a prompt, and it is enforced on the bytes actually
  read rather than on a `stat` the file can outgrow. Startup already applies
  the no-lockout rule to an unknown setting value.
- **Untrusted text is made safe at the parse boundary.** Escape sequences,
  control and format characters are stripped from both description sources and
  the description is capped, so every current and future picker surface gets
  the same treatment the name field already got. HTML comments are dropped
  where the body is cut, as the sibling `.qwen/rules/` loader does, so a
  human-only note is not fed to the model.
- **The picker resolves against the list it showed.** The hook keeps the
  catalog it loaded when opening and resolves the selection against that list
  rather than a fresh read, so the rows cannot swap under the cursor. The
  consequence is that a file deleted after the picker opened still applies from
  the open-time snapshot; the persisted name then warns and falls back to the
  default style at the next startup. The active style is added to that list
  when the catalog no longer carries it, so the marker stays truthful and one
  Enter cannot persist `default` over a live style.

## Out of scope

- Extension-bundled styles (`source: 'extension'`), including the
  `outputStyles` manifest field the Claude-plugin converter currently
  warns about. Next slice.
- A settings-file watcher applying a hand-edited `general.outputStyle`
  mid-session.
