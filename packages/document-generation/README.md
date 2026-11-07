# Word Document Extension

[English](README.md) | [简体中文](README.zh-CN.md)

Generate a Word document from a title and paragraphs, then publish it as a
downloadable Qwen session artifact. The extension runs locally over MCP stdio.
Its built server includes the document library and requires Node.js >=22.
Generation does not require Word, LibreOffice, Pandoc, or a network connection.

## Build and install

From the repository root:

```sh
corepack pnpm install --frozen-lockfile
npm run build --workspace=@qwen-code/document-generation
qwen extensions link ./packages/document-generation
```

Restart Qwen in the workspace where you want to generate documents. The
extension binds its server to that workspace using `${workspacePath}`.
It does not write documents into its installation directory.

Ask Qwen to create a Word document, or invoke
`/document-generation:generate-document`. For example:

```text
Create reports/nda.docx with the title "NDA" and the agreement paragraphs
we just drafted. Publish the Word document as a session artifact.
```

The skill calls the discovered `generate_docx` tool, then `record_artifact`
with the actual returned absolute path. If publication fails, the file stays
available for a registration retry; the skill must not regenerate it.

## Tool contract

`generate_docx` accepts:

```json
{
  "outputPath": "reports/nda.docx",
  "title": "NDA",
  "paragraphs": ["First agreement paragraph.", "Second agreement paragraph."]
}
```

The result contains `resolvedPath`, `mimeType`, and `sizeBytes` in structured
output and text. The tool writes the file; the skill publishes it separately.
The title becomes the document title, and each paragraph is literal text.

Limits are 200 title characters, 1000 paragraphs, 1 MiB total UTF-8 text,
and a 500-character relative output path. Invalid XML characters, parent
traversal, absolute paths, unsafe display or filename characters, and symlink parents
are rejected. Existing destinations, including symlinks, are never replaced.
Choose a new filename to create a revised document.

The generator supports DOCX with a title and paragraphs. It does not convert
files or create spreadsheets, slides, PDFs, tables, images, or templates.

## Write behavior and trust

The server stages complete bytes in a private temporary directory next to the
destination and creates the final filename using a hard link. Concurrent calls
cannot replace an existing destination. Filesystems without hard-link support
return a tool error. The server removes its temporary files after completion
or failure and checks cancellation before publishing the output.

The server uses your account's filesystem permissions. Path checks reject
unsafe tool inputs and existing redirects; they are not an operating-system
sandbox against another process changing directories during a write. Use the
extension in a trusted workspace. It does not log document bodies.

## Test and package

From this package directory:

```sh
npm test
npm run typecheck
```

Tests cover OOXML content through an independent ZIP/XML reader, filesystem
failures, cancellation, MCP calls, and the packed server. The packed-server
test denies filesystem reads outside the extracted package and fixture.

From the repository root, create an extension archive:

```sh
mkdir -p .qwen/releases
npm pack --workspace=@qwen-code/document-generation --pack-destination .qwen/releases
```

The archive includes the manifest, skill, bundled server, and emitted license
notices. Extract it and link the resulting `package` directory to Qwen.
This workspace is private so it does not join the CLI's registry releases.
The extension is installed explicitly and is not enabled in every Qwen session.
