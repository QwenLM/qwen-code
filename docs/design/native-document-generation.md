# Document Generation: DOCX MCP Proposal

[English](native-document-generation.md) | [简体中文](native-document-generation.zh-CN.md)

Status: Proposal, not implemented. Related issue: [#14616](https://github.com/QwenLM/qwen-code/issues/14616).

## Problem statement

A user asks for a Word contract and needs a file they can download and open.
Qwen Code can run scripts that generate documents, but users still need to
assemble the libraries, instructions, and artifact publication steps.

The proposed first deliverable is a local DOCX generator packaged as an MCP
extension with a companion skill. The skill coordinates generation and
publication through the existing artifact tool. This design PR proposes that
workflow; it ships no server, skill, dependency, or runtime change.

## Current state

The following source references describe existing behavior:

- [Tool result contracts](../../packages/core/src/tools/tools.ts) support
  document artifacts and result paths.
- [write_file](../../packages/core/src/tools/write-file.ts) recognizes Office
  extensions for artifact metadata. Its public content input is a string;
  it exposes no binary-buffer input or base64-decoding option.
- The [MCP result adapter](../../packages/core/src/tools/mcp-tool.ts) returns
  model content and display information without populating `ToolResult.artifacts`
  in its ordinary result conversion. A returned filename alone does not publish
  a workspace artifact through that conversion.
- [record_artifact](../../packages/core/src/tools/record-artifact.ts) verifies
  workspace file locations and returns artifact metadata. This establishes
  publication, not whether Word can open the file.
- The [extension guide](../users/extension/getting-started-extensions.md)
  describes packaging MCP servers and skills together.
- [exceljs is already a production dependency](../../packages/web-shell/package.json)
  of the Web Shell. The [preview parser](../../packages/web-shell/client/components/artifacts/excel-preview-parser.ts)
  uses it to load existing spreadsheets. This does not provide the proposed
  DOCX producer or settle a future server-side XLSX dependency decision.

These are source observations. They do not establish successful generation,
download, or Office application compatibility in a live session.

## Goals and scope

- Generate one DOCX containing a title and plain paragraphs.
- Publish the generated file through the existing artifact workflow.
- Package the generator and its document library so users need no converter
  installed for generation.
- Keep generation local and bound to the configured workspace.
- Give reviewers a concrete contract and validation plan before implementation.

The first version excludes XLSX, PPTX, PDF, templates, conversion, images,
tables, and editing existing documents. It adds no native core tool or new
transcript export format. A working extension can satisfy this request without
later moving generation into core.

## Delivery options

| Option                            | Benefit                                                              | Cost or limitation                                                      | Decision                          |
| --------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------- |
| Skill using Pandoc or LibreOffice | Reuses an existing local converter                                   | Requires a separate system installation and conversion workflow         | Document as a workaround          |
| Local MCP extension and skill     | Packages one producer without changing core                          | Requires extension installation and a separate publication call         | Recommended first delivery        |
| Native core tool                  | Could generate a file and return artifact metadata in one invocation | Requires a maintainer decision, dependency review, and core integration | Defer until evidence justifies it |

DOCX follows the contract example in the issue. This is a scope choice, not a
claim that DOCX has the highest demand. The existing artifact code reduces
integration work, but does not justify an implementation-time estimate.

## Proposed tool contract

The following types describe a proposed MCP tool named `generate_docx`.
They are not an existing Qwen API.

```ts
type GenerateDocxInput = {
  outputPath: string;
  title: string;
  paragraphs: string[];
};

type GenerateDocxResult = {
  resolvedPath: string;
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  sizeBytes: number;
};
```

`outputPath` is relative to the configured workspace and must end in `.docx`.
Reject absolute paths, parent traversal, and an existing destination. The
workspace root comes from trusted launch configuration, never from tool input.
Require a nonempty title and at least one paragraph. Render the title as the
document title and each paragraph as text, with no HTML or Markdown execution.

Use the `docx` library as the first candidate. Confirm its license, dependency
footprint, supported Node version, and packaged runtime before selecting a
version. Render bytes inside the server; do not send binary data through the
model or through `write_file`.

After a completed write, return the actual absolute `resolvedPath`, fixed MIME
type, and file size. Include the same small result in MCP `structuredContent`
and text content. On failure, return an MCP tool error without success metadata.
Define and test a documented input-size limit before release.

## Extension packaging and workspace binding

The proposed extension contains a built server, its runtime dependencies, and
`skills/generate-document/SKILL.md`. Use the existing extension mechanism;
the eventual distribution location remains a maintainer decision.

Illustrative manifest for that future extension:

```json
{
  "name": "document-generation",
  "version": "0.1.0",
  "mcpServers": {
    "documents": {
      "command": "node",
      "args": [
        "${extensionPath}${/}dist${/}server.js",
        "--workspace",
        "${workspacePath}"
      ],
      "cwd": "${workspacePath}"
    }
  }
}
```

`${extensionPath}` and `${workspacePath}` are existing
[extension variables](../../packages/core/src/extension/variableSchema.ts).
`--workspace` would be an argument implemented by the proposed server.
Resolve and validate that root at startup. Do not infer it from the extension
installation directory or accept another root in a model-generated call.

The initial target is a local stdio server with the same filesystem view as
Qwen's bound workspace. Remote servers and differing container filesystem
mappings require separate designs. Validate workspace binding in worktrees
and in two separate workspace sessions before claiming those modes work.

## Generation and publication workflow

1. The skill gathers the title, paragraphs, and requested destination.
2. It invokes the discovered MCP tool for `generate_docx`. Use the actual
   registered tool name rather than assuming a particular MCP naming prefix.
3. The server validates input, renders the document, and completes the write.
4. After generation succeeds, the skill calls `record_artifact` with the
   returned absolute path, explicit `kind: "document"`, MIME type, and size.
5. The assistant reports a downloadable artifact only after registration
   succeeds. If registration fails, report that generation succeeded but
   publication failed, retaining the file for a publication retry.

For an example workspace mounted at `/workspace`, publication would use:

```json
{
  "title": "nda.docx",
  "kind": "document",
  "workspacePath": "/workspace/reports/nda.docx",
  "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
}
```

The actual path must come from the server result. The skill must not regenerate
the file merely to retry publication, or record the same successful output
twice. It must report an unavailable or disabled publication tool explicitly.

This remains a model-coordinated workflow. Skill instructions do not guarantee
that every follow-up call happens. Session testing must check that handoff;
automatic conversion of MCP output into Qwen artifacts is outside this scope.

## Write safety and failure semantics

The external server owns its filesystem writes. Later artifact verification
does not protect a write that already happened. Existing Qwen path and atomic
write helpers are references, not a security guarantee inherited by the server.

The implementation must:

- Resolve outputs under the canonical launch-time workspace and reject
  symlink or junction redirects that escape it. A string-prefix check is
  insufficient. Review race conditions at the actual write operation.
- Render to a temporary file in the destination directory and publish only a
  complete file through a no-clobber operation. A separate existence check
  followed by an overwriting rename does not enforce no-clobber behavior.
- Preserve existing files on failure, remove only temporary files created by
  that invocation, and return success only after publication completes.
- Fail explicitly when the platform or filesystem cannot meet these write
  requirements. Do not silently fall back to a partial or overwriting write.
- Avoid logging document bodies. Make no network calls while generating a
  document. Follow the host's MCP approval and workspace trust decisions.

The exact write primitive needs review and platform tests during the prototype.
This proposal does not claim race-free confinement or sandbox enforcement for
an external Node process. If the required boundary cannot be established,
the prototype is not ready to ship.

## Phased implementation plan

1. **Build the standalone producer.** Add the single tool, document rendering,
   validated workspace binding, and no-clobber file output in the chosen
   extension project. Test the server directly before involving the model.
2. **Package the workflow.** Add the extension manifest and companion skill.
   Verify that an installed release starts without a global document library
   or a converter. Keep document instructions in the skill rather than adding
   them to every session's context.
3. **Verify the complete session.** Dry-run against the global `qwen` CLI,
   then check artifact publication and download in the Web Shell. Record the
   exact package versions, platform, prompts, failures, and output evidence.
4. **Review distribution and scope.** Ask maintainers where to distribute the
   extension and whether the evidence supports shipping it. Evaluate other
   formats or core integration separately, based on demonstrated demand.

## Validation plan

| Layer             | Check                                                                                                               | Expected evidence                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Producer          | Generate a title and Unicode paragraphs; parse the output with an independent DOCX reader                           | Expected text and paragraph structure survive                               |
| Writes            | Try traversal, absolute paths, redirected parents, existing destinations, concurrent writes, and interrupted writes | No workspace escape, overwritten destination, or success for a partial file |
| Packaging         | Install a built release without development dependencies or system converters                                       | Server starts and generates DOCX using its packaged runtime                 |
| Session           | Request an NDA, publish the returned path, and download the artifact                                                | Downloaded bytes match the server file                                      |
| Application       | Open the downloaded file in Word or LibreOffice                                                                     | No repair warning; expected title and paragraphs are present                |
| Failures          | Reject generation or artifact registration; disable the publication tool                                            | Clear failure state with no claim of a downloadable artifact                |
| Workspace binding | Generate in a worktree and in two separate workspace sessions                                                       | Each output remains in its configured workspace                             |

Run write and packaging checks on Linux, macOS, and Windows before declaring
cross-platform support. A ZIP signature or artifact entry alone does not prove
DOCX validity. The application check is separate from automated parsing.

This documentation PR requires formatting, reference, and bilingual parity
checks. It provides no runtime test results. Future session plans and evidence
belong in `.qwen/e2e-tests/` and the implementation PR's test report.

## Acceptance criteria

- An installed extension produces a valid DOCX from a title and paragraphs.
- Generation requires neither a global document library nor an installed
  converter, and makes no network calls.
- An output remains inside its configured workspace and cannot overwrite an
  existing destination, including under concurrent calls.
- A successful session publishes the exact generated file once, and its
  download preserves the bytes and opens in an Office application.
- A failed generation or publication produces an accurate failure report.
- Supported platforms and workspace modes have recorded runtime evidence.
- Both language versions describe the same scope, constraints, and decisions.

## Open decisions and follow-up

- Confirm who owns the extension and where its source and releases will live.
- Select the document-library version, payload limit, and write primitive
  after prototype measurements and review.
- Assess whether skill coordination is reliable enough for the intended
  workflow. Any automatic MCP artifact bridge needs its own proposal.
- For a future XLSX producer, evaluate `exceljs` first. Its Web Shell dependency
  does not automatically provide a dependency for a standalone server.
- Add another format or a native core tool only through a separate decision.
