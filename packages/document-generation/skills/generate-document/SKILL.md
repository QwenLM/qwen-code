---
name: generate-document
description: Generate a Word DOCX file from a title and paragraphs, then publish it as a downloadable session artifact.
---

# Generate a Word document

Use this skill when the user asks for a Word document, contract, memo, or report
as a `.docx` file. This extension supports a title and plain paragraphs only.

1. Identify the installed `documents` MCP server's `generate_docx` tool. Use
   its actual registered name. If it is unavailable, report that the document
   extension is not connected rather than creating a text file named `.docx`.
2. Prepare `title`, `paragraphs`, and a workspace-relative `outputPath` ending
   in `.docx`. Preserve the user's content and citations. Existing files cannot
   be overwritten; if the requested destination exists, ask for another name.
3. Call `generate_docx`. On an error, report the failure and do not claim a
   document was generated. Do not send document bytes through `write_file`.
4. After success, call Qwen's `record_artifact` tool with `title` set to
   `"Generated Word document"`, `kind: "document"`, `workspacePath` set to the exact returned
   absolute `resolvedPath`, and the returned `mimeType` and `sizeBytes`.
   Qwen derives the displayed filename when possible. This fixed fallback also
   allows filenames longer than the artifact title limit.
5. Report the downloadable document only after artifact registration succeeds.
   If the publication tool is unavailable or fails, say that the file was
   generated but could not be published. Preserve it and retry registration
   using the same path. Do not regenerate it or register a successful output
   twice.

The generator does not support PDFs, spreadsheets, slides, templates, tables,
images, or editing existing documents. Do not claim those features are available.
