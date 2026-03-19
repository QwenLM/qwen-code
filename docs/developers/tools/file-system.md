# Qwen Code file system tools

Qwen Code provides a comprehensive suite of tools for interacting with the local file system. These tools allow the model to read from, write to, list, search, and modify files and directories, all under your control and typically with confirmation for sensitive operations.

**Note:** All file system tools operate within a `rootDirectory` (usually the current working directory where you launched the CLI) for security. Paths that you provide to these tools are generally expected to be absolute or are resolved relative to this root directory.

## 1. `list_directory` (ListFiles)

`list_directory` lists the names of files and subdirectories directly within a specified directory path. It can optionally ignore entries matching provided glob patterns.

- **Tool name:** `list_directory`
- **Display name:** ListFiles
- **File:** `ls.ts`
- **Parameters:**
  - `path` (string, required): The absolute path to the directory to list.
  - `ignore` (array of strings, optional): A list of glob patterns to exclude from the listing (e.g., `["*.log", ".git"]`).
  - `respect_git_ignore` (boolean, optional): Whether to respect `.gitignore` patterns when listing files. Defaults to `true`.
- **Behavior:**
  - Returns a list of file and directory names.
  - Indicates whether each entry is a directory.
  - Sorts entries with directories first, then alphabetically.
- **Output (`llmContent`):** A string like: `Directory listing for /path/to/your/folder:\n[DIR] subfolder1\nfile1.txt\nfile2.png`
- **Confirmation:** No.

## 2. `read_file` (ReadFile)

`read_file` reads and returns the content of a specified file. This tool handles text files and media files (images, PDFs, audio, video) whose modality is supported by the current model. For text files, it can read specific line ranges. Media files whose modality is not supported by the current model are rejected with a helpful error message. Other binary file types are generally skipped.

- **Tool name:** `read_file`
- **Display name:** ReadFile
- **File:** `read-file.ts`
- **Parameters:**
  - `path` (string, required): The absolute path to the file to read.
  - `offset` (number, optional): For text files, the 0-based line number to start reading from. Requires `limit` to be set.
  - `limit` (number, optional): For text files, the maximum number of lines to read. If omitted, reads a default maximum (e.g., 2000 lines) or the entire file if feasible.
- **Behavior:**
  - For text files: Returns the content. If `offset` and `limit` are used, returns only that slice of lines. Indicates if content was truncated due to line limits or line length limits.
  - For media files (images, PDFs, audio, video): If the current model supports the file's modality, returns the file content as a base64-encoded `inlineData` object. If the model does not support the modality, returns an error message with guidance (e.g., suggesting skills or external tools).
  - For other binary files: Attempts to identify and skip them, returning a message indicating it's a generic binary file.
- **Output:** (`llmContent`):
  - For text files: The file content, potentially prefixed with a truncation message (e.g., `[File content truncated: showing lines 1-100 of 500 total lines...]\nActual file content...`).
  - For supported media files: An object containing `inlineData` with `mimeType` and base64 `data` (e.g., `{ inlineData: { mimeType: 'image/png', data: 'base64encodedstring' } }`).
  - For unsupported media files: An error message string explaining that the current model does not support this modality, with suggestions for alternatives.
  - For other binary files: A message like `Cannot display content of binary file: /path/to/data.bin`.
- **Confirmation:** No.

## 3. `write_file` (WriteFile)

`write_file` writes content to a specified file. If the file exists, it will be overwritten. If the file doesn't exist, it (and any necessary parent directories) will be created.

- **Tool name:** `write_file`
- **Display name:** WriteFile
- **File:** `write-file.ts`
- **Parameters:**
  - `file_path` (string, required): The absolute path to the file to write to.
  - `content` (string, required): The content to write into the file.
- **Behavior:**
  - Writes the provided `content` to the `file_path`.
  - Creates parent directories if they don't exist.
- **Output (`llmContent`):** A success message, e.g., `Successfully overwrote file: /path/to/your/file.txt` or `Successfully created and wrote to new file: /path/to/new/file.txt`.
- **Confirmation:** Yes. Shows a diff of changes and asks for user approval before writing.

## 4. `glob` (Glob)

`glob` finds files matching specific glob patterns (e.g., `src/**/*.ts`, `*.md`), returning absolute paths sorted by modification time (newest first).

- **Tool name:** `glob`
- **Display name:** Glob
- **File:** `glob.ts`
- **Parameters:**
  - `pattern` (string, required): The glob pattern to match against (e.g., `"*.py"`, `"src/**/*.js"`).
  - `path` (string, optional): The directory to search in. If not specified, the current working directory will be used.
- **Behavior:**
  - Searches for files matching the glob pattern within the specified directory.
  - Returns a list of absolute paths, sorted with the most recently modified files first.
  - Respects .gitignore and .qwenignore patterns by default.
  - Limits results to 100 files to prevent context overflow.
- **Output (`llmContent`):** A message like: `Found 5 file(s) matching "*.ts" within /path/to/search/dir, sorted by modification time (newest first):\n---\n/path/to/file1.ts\n/path/to/subdir/file2.ts\n---\n[95 files truncated] ...`
- **Confirmation:** No.

## 5. `grep_search` (Grep)

`grep_search` searches for a regular expression pattern within the content of files in a specified directory. Can filter files by a glob pattern. Returns the lines containing matches, along with their file paths and line numbers.

- **Tool name:** `grep_search`
- **Display name:** Grep
- **File:** `grep.ts` (with `ripGrep.ts` as fallback)
- **Parameters:**
  - `pattern` (string, required): The regular expression pattern to search for in file contents (e.g., `"function\\s+myFunction"`, `"log.*Error"`).
  - `path` (string, optional): File or directory to search in. Defaults to current working directory.
  - `glob` (string, optional): Glob pattern to filter files (e.g. `"*.js"`, `"src/**/*.{ts,tsx}"`).
  - `limit` (number, optional): Limit output to first N matching lines. Optional - shows all matches if not specified.
- **Behavior:**
  - Uses ripgrep for fast search when available; otherwise falls back to a JavaScript-based search implementation.
  - Returns matching lines with file paths and line numbers.
  - Case-insensitive by default.
  - Respects .gitignore and .qwenignore patterns.
  - Limits output to prevent context overflow.
- **Output (`llmContent`):** A formatted string of matches, e.g.:

  ```
  Found 3 matches for pattern "myFunction" in path "." (filter: "*.ts"):
  ---
  src/utils.ts:15:export function myFunction() {
  src/utils.ts:22:  myFunction.call();
  src/index.ts:5:import { myFunction } from './utils';
  ---

  [0 lines truncated] ...
  ```

- **Confirmation:** No.

### `grep_search` examples

Search for a pattern with default result limiting:

```
grep_search(pattern="function\\s+myFunction", path="src")
```

Search for a pattern with custom result limiting:

```
grep_search(pattern="function", path="src", limit=50)
```

Search for a pattern with file filtering and custom result limiting:

```
grep_search(pattern="function", glob="*.js", limit=10)
```

## 6. `edit` (Edit)

`edit` replaces text within a file. By default it requires `old_string` to match a single unique location; set `replace_all` to `true` when you intentionally want to change every occurrence. This tool is designed for precise, targeted changes and requires significant context around the `old_string` to ensure it modifies the correct location.

- **Tool name:** `edit`
- **Display name:** Edit
- **File:** `edit.ts`
- **Parameters:**
  - `file_path` (string, required): The absolute path to the file to modify.
  - `old_string` (string, required): The exact literal text to replace.

    **CRITICAL:** This string must uniquely identify the single instance to change. It should include sufficient context around the target text, matching whitespace and indentation precisely. If `old_string` is empty, the tool attempts to create a new file at `file_path` with `new_string` as content.

  - `new_string` (string, required): The exact literal text to replace `old_string` with.
  - `replace_all` (boolean, optional): Replace all occurrences of `old_string`. Defaults to `false`.

- **Behavior:**
  - If `old_string` is empty and `file_path` does not exist, creates a new file with `new_string` as content.
  - If `old_string` is provided, it reads the `file_path` and attempts to find exactly one occurrence unless `replace_all` is true.
  - If the match is unique (or `replace_all` is true), it replaces the text with `new_string`.
  - **Enhanced Reliability (Multi-Stage Edit Correction):** To significantly improve the success rate of edits, especially when the model-provided `old_string` might not be perfectly precise, the tool incorporates a multi-stage edit correction mechanism.
    - If the initial `old_string` isn't found or matches multiple locations, the tool can leverage the Qwen model to iteratively refine `old_string` (and potentially `new_string`).
    - This self-correction process attempts to identify the unique segment the model intended to modify, making the `edit` operation more robust even with slightly imperfect initial context.
- **Failure conditions:** Despite the correction mechanism, the tool will fail if:
  - `file_path` is not absolute or is outside the root directory.
  - `old_string` is not empty, but the `file_path` does not exist.
  - `old_string` is empty, but the `file_path` already exists.
  - `old_string` is not found in the file after attempts to correct it.
  - `old_string` is found multiple times, `replace_all` is false, and the self-correction mechanism cannot resolve it to a single, unambiguous match.
- **Output (`llmContent`):**
  - On success: `Successfully modified file: /path/to/file.txt (1 replacements).` or `Created new file: /path/to/new_file.txt with provided content.`
  - On failure: An error message explaining the reason (e.g., `Failed to edit, 0 occurrences found...`, `Failed to edit because the text matches multiple locations...`).
- **Confirmation:** Yes. Shows a diff of the proposed changes and asks for user approval before writing to the file.

## File encoding and platform-specific behavior

### Encoding detection and preservation

When reading files, Qwen Code detects the file's encoding using a multi-step strategy:

1. **UTF-8** — tried first (most modern tooling outputs UTF-8)
2. **chardet** — statistical detection for non-UTF-8 content
3. **System encoding** — falls back to the OS code page (Windows `chcp` / Unix `LANG`)

Both `write_file` and `edit` preserve the original encoding and BOM (byte order mark) of existing files. If a file was read as GBK with a UTF-8 BOM, it will be written back the same way.

### Configuring default encoding for new files

The `defaultFileEncoding` setting controls encoding for **newly created** files (not edits to existing files):

| Value       | Behavior                                                                    |
| ----------- | --------------------------------------------------------------------------- |
| _(not set)_ | UTF-8 without BOM, with automatic platform-specific adjustments (see below) |
| `utf-8`     | UTF-8 without BOM, no automatic adjustments                                 |
| `utf-8-bom` | UTF-8 with BOM for all new files                                            |

Set it in `.qwen/settings.json` or `~/.qwen/settings.json`:

```json
{
  "general": {
    "defaultFileEncoding": "utf-8-bom"
  }
}
```

### Windows: CRLF for batch files

On Windows, `.bat` and `.cmd` files are automatically written with CRLF (`\r\n`) line endings. This is required because `cmd.exe` uses CRLF as its line delimiter — LF-only endings can break multi-line `if`/`else`, `goto` labels, and `for` loops. This applies regardless of encoding settings and only on Windows.

### Windows: UTF-8 BOM for PowerShell scripts

On Windows with a **non-UTF-8 system code page** (e.g. GBK/cp936, Big5/cp950, Shift_JIS/cp932), newly created `.ps1` files are automatically written with a UTF-8 BOM. This is necessary because Windows PowerShell 5.1 (the version built into Windows 10/11) reads BOM-less scripts using the system's ANSI code page. Without a BOM, any non-ASCII characters in the script will be misinterpreted.

This automatic BOM only applies when:

- The platform is Windows
- The system code page is not UTF-8 (not code page 65001)
- The file is a new `.ps1` file (existing files keep their original encoding)
- The user has **not** explicitly set `defaultFileEncoding` in settings

PowerShell 7+ (pwsh) defaults to UTF-8 and handles BOM transparently, so the BOM is harmless there.

If you explicitly set `defaultFileEncoding` to `"utf-8"`, the automatic BOM is disabled — this is an intentional escape hatch for repositories or tooling that reject BOMs.

### Summary

| File type      | Platform                      | Automatic behavior          |
| -------------- | ----------------------------- | --------------------------- |
| `.bat`, `.cmd` | Windows                       | CRLF line endings           |
| `.ps1`         | Windows (non-UTF-8 code page) | UTF-8 BOM on new files      |
| All others     | All                           | UTF-8 without BOM (default) |

These file system tools provide a foundation for Qwen Code to understand and interact with your local project context.
