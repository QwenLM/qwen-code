# Literal file content in custom commands

[中文](./2026-10-15-custom-command-file-literals.zh-CN.md)

## Contract

Command definitions are templates; files read by `@{...}` are data. File contents must not become shell expressions or argument placeholders, including malformed template syntax. Existing template-owned shell approval, denial and escaping remain unchanged. Read errors retain the existing visible placeholder/error behavior.

Both TOML and Markdown loaders use the command factory, which runs AtFile, Shell, then DefaultArgument processing. Preserve this order: reversing it would interpret paths from substituted user arguments or shell output. Confirmation retries rebuild the original template and reread files.

## Change

Mark every reader-produced part in a CLI-local WeakSet, converting primitive strings to text objects first. Shell processing checks identity before extracting text and passes marked parts through unchanged. Preserve sequential processing and part order, including directory headings and media. No schema fields, wire metadata or new parser are needed; retain the existing injection parser for template fragments. Default argument appending happens last and needs no provenance.

The trust boundary is the file-reader output. The factory has no cloning or serialization between the two processors. Future processors that interpret text must preserve/check this boundary; this change does not claim to secure arbitrary future pipelines.

## Verification

A real CLI baseline attempted to authorize `!{echo FROM_FILE}` from the injected file and failed before contacting the model. Repeat against a local stub endpoint after the fix: the model must receive that expression and file `{{args}}` verbatim while the template's argument expands. A template-owned shell expression must still execute with its normal permission rules.

Factory integration tests cover string and object file parts, malformed file syntax, mixed media, approval/retry, and literal shell output/user arguments. Run the existing processor suites, build, typecheck, lint and formatting checks.
