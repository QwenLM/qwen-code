# DOCX Generation Implementation Plan

[English](docx-generation.md) | [简体中文](docx-generation.zh-CN.md)

Deliver a local DOCX MCP extension with a companion publication skill.
A private workspace package bundles the MCP SDK and document library into one
Node.js server. Qwen discovers its tool through the existing extension manifest,
and the skill publishes the completed file separately.
See the [document generation design](../design/native-document-generation.md).

## Constraints

- Node.js >=22, ESM, strict TypeScript, and the repository's pinned pnpm.
- One format, a title and paragraphs, and no changes to native core tools.
- Fixed launch-time workspace, no overwrites, local generation, no body logs.
- Documents and the PR description remain complete in English and Chinese.

## Review focus

- A packaged server must work without access to repository dependencies.
- Failed publication must not trigger regeneration or claim a download exists.
- Concurrent calls and existing symlinks must not overwrite another file.
- Invalid XML characters must not produce a document Word needs to repair.
- Workspace binding must come from launch configuration, not a model argument.

## Producer and filesystem contract

Files: `packages/document-generation/src/generate-docx.ts` and its collocated
test. Interface: `createDocxGenerator(workspacePath)` returns an asynchronous
generator accepting unknown input and an optional cancellation signal, and
returning `resolvedPath`, `mimeType`, and `sizeBytes`.

- [x] Write and run failing tests for OOXML text/Unicode, invalid input,
      workspace traversal, symlink parents, no-clobber concurrency, and aborts.
- [x] Implement bounded schemas and rendering with `docx`.
- [x] Stage complete bytes privately and use a hard link to create the final
      filename without replacing an existing directory entry.
- [x] Run the producer tests and inspect the generated document independently.

## MCP transport, package, and skill

Files: `src/mcp-server.ts`, `src/server.ts`, collocated protocol tests,
the extension manifest, skill, package metadata, and build configuration.
Interface: the sole tool `generate_docx` returns structured output plus text,
and expected execution failures return `isError: true`.

- [x] Write failing SDK-client tests for real tool discovery, generation,
      validation errors, protocol output, and process shutdown.
- [x] Implement stdio startup with a required absolute `--workspace` argument.
- [x] Bundle runtime dependencies; add exact workspace dependency locking.
- [x] Package the skill to call the discovered generator then `record_artifact`.
- [x] Pack and run an extracted server without repository module resolution.

## Repository integration and evidence

Files: pnpm workspace-name hooks, Vitest config registration, both design
documents, both package READMEs, and the PR description.

- [x] Run the package tests, build, typecheck, lint, and workspace meta-tests.
- [x] Build and typecheck the repository, then bundle the CLI.
- [x] Run the E2E plan in `.qwen/e2e-tests/docx-generation.md`, including
      independent document opening and Qwen generation/publication wiring.
- [x] Complete two clean self-audit passes and independent code review.
- [x] Prepare the PR description and E2E report in English and Chinese.
