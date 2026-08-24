# Computer Use Skill Integration

## Decision

Qwen Code bundles only one Computer Use artifact: the `computer-use` skill.

```text
user task
  -> bundled computer-use skill
  -> skill-installed @qwen-code/node-repl-mcp
  -> model-authored JavaScript
  -> skill-installed @qwen-code/cua-sdk/computer-use
  -> native cua-driver accessibility backend
```

The previous built-in Computer Use tools, settings, schemas, downloader,
permission bootstrap, and direct runtime are removed. There is no mode switch,
bundled SDK, native payload staging, or fallback path.

## Automatic bootstrap

When `node_repl` is unavailable, the skill runs the exact, versioned
`qwen mcp add` and workspace-local SDK installation commands itself. Adding the
server changes user configuration and requires a Qwen Code restart, so the
skill tells the user to restart and resumes the desktop task in the next
session.

The SDK is resolved from the workspace used by Node REPL. If the dynamic import
fails while `node_repl` is already available, the skill runs the SDK
installation command and retries the import. Qwen Code itself has no dependency
on either package.

This boundary keeps installation, trust, disk use, native downloads, and
platform permissions visible to the user.

## Runtime contract

The external MCP server owns the persistent Node.js kernel and its lifecycle.
The model uses dynamic imports and the typed `ComputerUse` methods only; it
does not dispatch arbitrary driver tool names or use a Qwen-specific global
bridge.

After bootstrap, the skill follows the same workflow as the Codex Computer Use
skill: observe the target application, prefer semantic elements over
coordinates, act through the typed SDK, fetch fresh state after every mutation,
use screenshots when accessibility text is insufficient, and clean up when the
task finishes.

MCP approval policy guards model-authored JavaScript. The SDK and native driver
retain their own authorization and platform permission behavior. Removing the
built-in runtime does not weaken either boundary.

## Publication

`@qwen-code/node-repl-mcp` is a standalone npm package with version `0.1.0`.
It is published by the existing CUA SDK release workflow, but its version is
independent from `@qwen-code/cua-sdk` and cua-driver releases.

The workflow:

1. builds, type-checks, tests, and packs the Node REPL package;
2. clean-installs the tarball and drives its real stdio MCP surface;
3. verifies the package contents;
4. performs an immutable npm check and publishes with provenance; and
5. supports a Node-REPL-only bootstrap dispatch so an existing immutable
   cua-driver release is not recreated.

Dry-run executes the build and package verification path without publishing
either npm package or creating/replacing a GitHub Release.

## Scope guard

This change does not:

- register an MCP server inside Qwen Code;
- add `@qwen-code/node-repl-mcp` or `@qwen-code/cua-sdk` as a Qwen runtime
  dependency;
- stage CUA native assets into npm, standalone, Desktop, or VSIX artifacts;
- change cua-driver contracts or SDK behavior; or
- retain a hidden copy of the removed built-in Computer Use implementation.

## Verification

The change is complete when:

1. the bundled skill validates and is discoverable;
2. no old Computer Use tool, setting, schema, downloader, or direct runtime
   remains;
3. Qwen Code bundles no Node REPL server or CUA SDK payload;
4. a natural desktop task causes the skill to bootstrap missing external
   packages and then complete a real observe, action, verification, and cleanup
   flow without the prompt naming implementation details; and
5. the CUA release workflow dry-run verifies the independently versioned Node
   REPL tarball without publishing.
