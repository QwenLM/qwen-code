# DOCX Generation Through a Local MCP Extension

[English](native-document-generation.md) | [简体中文](native-document-generation.zh-CN.md)

Implementation: [draft PR #14665](https://github.com/QwenLM/qwen-code/pull/14665).
Related issue: [#14616](https://github.com/QwenLM/qwen-code/issues/14616).

## Problem statement

A user requesting a Word contract needs a file they can download and open.
Qwen can run document-generation scripts, but users otherwise need to assemble
the library, tool instructions, and artifact publication themselves.

The document-generation extension supplies that workflow for DOCX. Its local
MCP tool writes a document from a title and paragraphs. Its companion skill
then publishes the file through Qwen's existing artifact tool.

## Current state and integration

- [write_file](../../packages/core/src/tools/write-file.ts) accepts string
  content and recognizes Office extensions for artifact metadata. It does not
  expose a binary-buffer input or base64-decoding option.
- The ordinary [MCP result adapter](../../packages/core/src/tools/mcp-tool.ts)
  returns model content and display data without populating `ToolResult.artifacts`.
- [record_artifact](../../packages/core/src/tools/record-artifact.ts) verifies
  a workspace file and returns the metadata used to publish it.
- [Extension variables](../../packages/core/src/extension/variableSchema.ts)
  provide distinct installation and workspace paths.
- The [Web Shell](../../packages/web-shell/package.json) already depends on
  `exceljs` for [spreadsheet previews](../../packages/web-shell/client/components/artifacts/excel-preview-parser.ts).
  That dependency does not supply a DOCX producer or a standalone XLSX server.

The new [workspace package](../../packages/document-generation/README.md)
implements the producer without changing those core contracts.

## Goals and scope

- Generate a DOCX containing a title and literal text paragraphs.
- Return the exact file location and publish it as a session artifact.
- Bundle the runtime so generation needs only Node.js >=22.
- Keep document generation local, without converter binaries or body logs.
- Preserve existing destinations, including under concurrent calls.

The extension is installed explicitly. It is not enabled in every Qwen
installation. Other formats, conversion, templates, tables, images, editing,
and native core integration remain outside this change.

## Design decisions

| Decision                    | Reason                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| Private workspace extension | Uses normal build, tests, typecheck, and dependency locking without joining automatic registry releases |
| One bundled stdio server    | Installed copies do not need repository dependencies or a separate document library installation        |
| DOCX first                  | Matches the contract example and keeps the first workflow small                                         |
| Title and paragraphs        | Avoids introducing a document-layout language                                                           |
| Separate publication call   | Reuses the existing artifact tool without changing MCP result ingestion                                 |
| No-clobber output           | A retry or concurrent generation cannot replace another document                                        |

## Tool contract

The sole MCP tool is `generate_docx`. Its
[input schema and renderer](../../packages/document-generation/src/generate-docx.ts)
accept the following shape:

```json
{
  "outputPath": "reports/nda.docx",
  "title": "NDA",
  "paragraphs": ["First agreement paragraph.", "Second agreement paragraph."]
}
```

The result contains the absolute `resolvedPath`, fixed DOCX `mimeType`, and
`sizeBytes` in both structured output and text. The server returns an MCP tool
error for expected failures, without success metadata.

Limits are 200 title characters, 1000 paragraphs, 1 MiB total UTF-8 text, and
a 500-character relative output path. Invalid XML characters, absolute paths,
parent traversal, unsafe display or filename characters, and unknown input keys are
rejected. The title uses the document title style. Paragraphs are literal text.

## Runtime and workspace binding

The [manifest](../../packages/document-generation/qwen-extension.json) starts
the bundled server from `${extensionPath}` and supplies `${workspacePath}`
through its required `--workspace` argument and working directory.
The server resolves the workspace at startup. Tool input cannot replace it.

Runtime dependencies are `docx` 9.12.0, MCP SDK 1.30.0, and Zod 3.25.76,
with integrity records in the workspace lockfile. The SDK supports protocol
`2025-11-25`; its [source revision](https://github.com/modelcontextprotocol/typescript-sdk/tree/2d889f2b329e46680ec9bdd565de4616c497825a)
is pinned by the package release. The build bundles dependencies into ESM
targeting Node.js 22 and retains emitted license notices.

The server uses local stdio and the same filesystem view as Qwen's workspace.
Remote filesystem mappings are outside this implementation.

## Generation and publication

1. The [skill](../../packages/document-generation/skills/generate-document/SKILL.md)
   prepares the title, paragraphs, and relative destination.
2. It calls the discovered MCP `generate_docx` tool by its actual registered name.
3. The server validates input, renders OOXML, and publishes complete file bytes.
4. The skill calls `record_artifact` with the returned absolute path as
   `workspacePath`, explicit `kind: "document"`, MIME type, and size. It uses
   `"Generated Word document"` as a bounded title fallback; Qwen derives the
   filename when it fits its title rules.
5. The assistant reports a downloadable artifact after registration succeeds.

If generation fails, the skill reports the error. If registration fails or is
unavailable, it reports that the file was generated but not published and
retains the file for a registration retry. It must not regenerate the file
or register an already successful output twice.

The skill coordinates these calls through the model. Automatic ingestion of
MCP artifact metadata is a separate feature and is not needed by this workflow.

## Write safety and failure behavior

The generator resolves output directories beneath the canonical workspace and
rejects existing symlink or junction parents. It stages bytes in a private
temporary directory beside the destination, flushes and closes the file, then
uses a hard link to create the final filename. The link fails if a destination
already exists, so there is no overwrite window between checking and publishing.

The generator checks cancellation before publication and removes its temporary
files after success or failure. Unsupported hard links or write permissions
produce a tool error. An existing output is retained. A cleanup failure is
reported to stderr without changing a successfully created document into a
failed generation result.

The external MCP process runs with the user's filesystem permissions. Input
and redirect checks are not an OS sandbox against another process replacing
directories concurrently. The workspace must be trusted. Artifact verification
after generation cannot secure an earlier filesystem write.

## Repository integration and packaging

The existing `packages/*` workspace globs include the extension. The pnpm
workspace-name hook and Vitest configuration registry include its package.
It has normal build, test, CI test, and typecheck scripts.

The extension archive contains its manifest, skill, README pair, bundled server,
and emitted license notices. It excludes source tests and `node_modules`.
Marking the package private keeps it out of automatic public release scripts.
Local linking and extraction instructions are in the package README pair.

## Validation

| Boundary         | Evidence checked by the implementation tests                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Document content | An independent ZIP/XML reader verifies title, Unicode, literal XML characters, and paragraph order                     |
| Filesystem       | Traversal, existing symlink parents and destinations, existing files, concurrent writers, and temporary cleanup        |
| Cancellation     | Cancellation before generation and during asynchronous rendering leaves no published file                              |
| MCP              | Real SDK discovery and calls, structured/text output, validation failures, and overwrite errors                        |
| Packaged runtime | An extracted archive runs with Node filesystem reads restricted to the fixture, preventing repository dependency reads |
| Startup          | Missing and relative workspace arguments fail without writing protocol output to stdout                                |

The E2E plan in `.qwen/e2e-tests/docx-generation.md` records runtime evidence
separately, including independent application opening and Qwen publication
wiring. A ZIP signature or artifact entry alone does not establish a usable
document. The PR test report states the actual platforms and model setup used.

## Acceptance criteria and follow-up

- The installed extension produces a valid DOCX from the requested content.
- Packaged generation requires no system converter or global document library.
- Unsafe output paths and existing redirects are rejected; concurrent calls
  do not replace an existing destination.
- The workflow publishes the exact generated file and reports failures accurately.
- Tests exercise the producer, protocol, and isolated packaged runtime.
- English and Chinese documentation describe the same behavior and limits.

Registry publication is a separate maintainer decision. Future XLSX work should
evaluate `exceljs` first. Additional formats, richer document layouts, and core
integration each need their own scope and evidence.
