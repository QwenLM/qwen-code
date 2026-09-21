/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { ShellConfiguration, ShellType } from '../utils/shell-utils.js';
import { PDF_MAX_PAGES_PER_READ } from '../utils/pdf-constants.js';
import type { ManagedToolDescriptor } from './managed-tool-protocol.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { Kind } from './tools.js';

export const DEFAULT_SHELL_OUTPUT_THRESHOLD = 30_000;

function defineTool(
  name: string,
  displayName: string,
  description: string,
  kind: Kind,
  parameterSchema: unknown,
  isOutputMarkdown = true,
  canUpdateOutput = false,
): ManagedToolDescriptor {
  return {
    name,
    displayName,
    description,
    kind,
    schema: { name, description, parametersJsonSchema: parameterSchema },
    isOutputMarkdown,
    canUpdateOutput,
    shouldDefer: false,
    alwaysLoad: false,
    truncateKeep: 'both',
  };
}

export function getZoomImageToolDefinition(): ManagedToolDescriptor {
  return {
    ...defineTool(
      ToolNames.ZOOM_IMAGE,
      ToolDisplayNames.ZOOM_IMAGE,
      'Crops a region from a full-resolution static image and returns a magnified view. Coordinates are integers normalized from 0 to 1000 against the displayed image, with (0,0) at top-left and (1000,1000) at bottom-right. Use this when text, numbers, lines, or other details are too small to inspect confidently. You may call it repeatedly; coordinates always refer to the original full-resolution image, never to a previously returned view.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to a static PNG, JPEG, or WebP image.',
          },
          x1: {
            type: 'integer',
            minimum: 0,
            maximum: 1000,
            description: 'Left edge in normalized image coordinates.',
          },
          y1: {
            type: 'integer',
            minimum: 0,
            maximum: 1000,
            description: 'Top edge in normalized image coordinates.',
          },
          x2: {
            type: 'integer',
            minimum: 0,
            maximum: 1000,
            description: 'Right edge in normalized image coordinates.',
          },
          y2: {
            type: 'integer',
            minimum: 0,
            maximum: 1000,
            description: 'Bottom edge in normalized image coordinates.',
          },
        },
        required: ['file_path', 'x1', 'y1', 'x2', 'y2'],
      },
    ),
    shouldDefer: true,
    searchHint:
      'zoom crop magnify image picture screenshot chart diagram small text detail',
  };
}

export function getGlobToolDefinition(): ManagedToolDescriptor {
  return defineTool(
    ToolNames.GLOB,
    ToolDisplayNames.GLOB,
    'Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like "**/*.js" or "src/**/*.ts"\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns\n- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead\n- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.',
    Kind.Search,
    {
      properties: {
        pattern: {
          description: 'The glob pattern to match files against',
          type: 'string',
        },
        path: {
          description:
            'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
          type: 'string',
        },
      },
      required: ['pattern'],
      type: 'object',
    },
  );
}

export function getGrepToolDefinition(): ManagedToolDescriptor {
  return {
    ...defineTool(
      ToolNames.GREP,
      ToolDisplayNames.GREP,
      'Search file contents using the available search backend.\n- Use Grep for content searches instead of invoking grep or rg through Bash.\n- Accepts regular expression patterns; syntax and case handling depend on the available backend.\n- Filter files with glob patterns such as "*.js" or "**/*.tsx".\n- Use the Agent tool for open-ended searches requiring multiple rounds.',
      Kind.Search,
      {
        properties: {
          pattern: {
            type: 'string',
            description:
              'The regular expression pattern to search for in file contents',
          },
          glob: {
            type: 'string',
            description:
              'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")',
          },
          path: {
            type: 'string',
            description:
              'Directory to search in; file paths are also supported by the ripgrep backend. Defaults to the workspace directories.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            description:
              'Maximum matching lines to return. Must be a positive integer. Configured output limits still apply when omitted.',
          },
        },
        required: ['pattern'],
        type: 'object',
      },
    ),
    maxOutputChars: 20_000,
  };
}

export function getLSToolDefinition(): ManagedToolDescriptor {
  return defineTool(
    ToolNames.LS,
    ToolDisplayNames.LS,
    'Lists the names of files and subdirectories directly within a specified directory path. Can optionally ignore entries matching provided glob patterns.',
    Kind.Search,
    {
      properties: {
        path: {
          description:
            'The absolute path to the directory to list (must be absolute, not relative)',
          type: 'string',
        },
        ignore: {
          description: 'List of glob patterns to ignore',
          items: {
            type: 'string',
          },
          type: 'array',
        },
        file_filtering_options: {
          description:
            'Optional: Whether to respect ignore patterns from .gitignore, .qwenignore, and configured custom Qwen ignore files',
          type: 'object',
          properties: {
            respect_git_ignore: {
              description:
                'Optional: Whether to respect .gitignore patterns when listing files. Only available in git repositories. Defaults to true.',
              type: 'boolean',
            },
            respect_qwen_ignore: {
              description:
                'Optional: Whether to respect .qwenignore and configured custom Qwen ignore file patterns when listing files. Defaults to true.',
              type: 'boolean',
            },
          },
        },
      },
      required: ['path'],
      type: 'object',
    },
  );
}

export function getReadFileToolDefinition(): ManagedToolDescriptor {
  return {
    ...defineTool(
      ToolNames.READ_FILE,
      ToolDisplayNames.READ_FILE,
      `Reads and returns the content of a specified file. The file_path argument MUST be an absolute path. Always construct it by combining the project root with the file's relative path (e.g. project root '/path/to/project/' + relative 'foo/bar.txt' = '/path/to/project/foo/bar.txt'). If the user provides a relative path, resolve it against the project root first. If the file is large, the content will be truncated. The tool's response will clearly indicate if truncation has occurred and will provide details on how to read more of the file using the 'offset' and 'limit' parameters. Handles text, images (PNG, JPG, GIF, WEBP, SVG, BMP), PDF files, and Jupyter notebooks (.ipynb). For text files, it can read specific line ranges. For PDF files, use the 'pages' parameter to extract specific page ranges as text (e.g. '1-5'). Max ${PDF_MAX_PAGES_PER_READ} pages per request. Large PDFs cannot be read all at once when the model does not support native PDF input; retry with narrower page ranges if the tool reports a PDF is too large. With a configured vision bridge, failed PDF text extraction or an irreducibly large single page may be transcribed automatically, at most four pages per call; this transcription is lossy and marked as untrusted. This tool can read Jupyter notebooks (.ipynb) and returns structured cell content with outputs.`,
      Kind.Read,
      {
        properties: {
          file_path: {
            description:
              "The absolute path to the file to read (e.g., '/home/user/project/file.txt'). Relative paths are not supported. You must provide an absolute path.",
            type: 'string',
          },
          offset: {
            description:
              "Optional: For text files, the 0-based line number to start reading from. Requires 'limit' to be set. Use for paginating through large files.",
            type: 'integer',
          },
          limit: {
            description:
              "Optional: For text files, maximum number of lines to read. Use with 'offset' to paginate through large files. If omitted, reads the entire file (if feasible, up to a default limit).",
            type: 'integer',
          },
          pages: {
            description: `Optional: For PDF files, the page range to extract as text (e.g., '1-5', '3', '10-20'). Pages are 1-indexed. Max ${PDF_MAX_PAGES_PER_READ} pages per request. Open-ended ranges like '3-' are not supported. Use this for large PDFs or when the model does not support native PDF input.`,
            type: 'string',
          },
        },
        required: ['file_path'],
        type: 'object',
      },
    ),
    maxOutputChars: 'unlimited',
  };
}

export function getWriteFileToolDefinition(): ManagedToolDescriptor {
  return defineTool(
    ToolNames.WRITE_FILE,
    ToolDisplayNames.WRITE_FILE,
    `Writes content to a specified file in the local filesystem. A request to create or generate a file does not establish that the target path is new. Unless the target's absence or current text contents have already been established in this session, you MUST use the ${ToolNames.READ_FILE} tool first; if the file does not exist, then create it. With prior-read enforcement enabled, blind overwrites are rejected. The file_path argument MUST be an absolute path. Always construct it by combining the project root with the file's relative path (e.g. project root '/path/to/project/' + relative 'foo/bar.txt' = '/path/to/project/foo/bar.txt'). If the user provides a relative path, resolve it against the project root first.

Artifact-like files such as HTML, PDF, images, notebooks, and office documents are automatically registered as session artifacts. Intermediate files that exist only to produce another artifact — for example HTML written solely to print a PDF — must set record_as_artifact=false, or be written under .qwen/tmp/ so they are not registered. Delete those intermediates when done.

The user has the ability to modify \`content\`. If modified, this will be stated in the response.`,
    Kind.Edit,
    {
      properties: {
        file_path: {
          description:
            "The absolute path to the file to write to (e.g., '/home/user/project/file.txt'). Relative paths are not supported.",
          type: 'string',
        },
        content: {
          description: 'The content to write to the file.',
          type: 'string',
        },
        record_as_artifact: {
          description:
            'Set false for intermediate files that should not appear as session artifacts, such as HTML used only to print a PDF. Defaults to true for artifact-like extensions.',
          type: 'boolean',
        },
      },
      required: ['file_path', 'content'],
      type: 'object',
    },
  );
}

export function getEditToolDefinition(): ManagedToolDescriptor {
  return defineTool(
    ToolNames.EDIT,
    ToolDisplayNames.EDIT,
    `Replaces text within a file. By default, replaces a single occurrence. Set \`replace_all\` to true when you intend to modify every instance of \`old_string\`. This tool requires providing significant context around the change to ensure precise targeting. Always use the ${ToolNames.READ_FILE} tool to examine the file's current content before attempting a text replacement.

      The user has the ability to modify the \`new_string\` content. If modified, this will be stated in the response.

Expectation for required parameters:
1. \`file_path\` MUST be an absolute path; otherwise an error will be thrown.
2. \`old_string\` MUST be the exact literal text to replace (including all whitespace, indentation, newlines, and surrounding code etc.).
3. \`new_string\` MUST be the exact literal text to replace \`old_string\` with (also including all whitespace, indentation, newlines, and surrounding code etc.). Ensure the resulting code is correct and idiomatic.
4. NEVER escape \`old_string\` or \`new_string\`, that would break the exact literal text requirement.
**Important:** If ANY of the above are not satisfied, the tool will fail. CRITICAL for \`old_string\`: Must uniquely identify the single instance to change. Include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string matches multiple locations, or does not match exactly, the tool will fail.
**Multiple replacements:** Set \`replace_all\` to true when you want to replace every occurrence that matches \`old_string\`.`,
    Kind.Edit,
    {
      properties: {
        file_path: {
          description:
            "The absolute path to the file to modify. Must start with '/'.",
          type: 'string',
        },
        old_string: {
          description:
            'The exact literal text to replace, preferably unescaped. For single replacements (default), include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string is not the exact literal text (i.e. you escaped it) or does not match exactly, the tool will fail.',
          type: 'string',
        },
        new_string: {
          description:
            'The exact literal text to replace `old_string` with, preferably unescaped. Provide the EXACT text. Ensure the resulting code is correct and idiomatic.',
          type: 'string',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences of old_string (default false).',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
      type: 'object',
    },
  );
}

export interface ShellToolDefinitionOptions {
  shellConfiguration: ShellConfiguration;
  platform: NodeJS.Platform;
  outputThreshold?: number;
}

export function getShellToolDefinition({
  shellConfiguration,
  platform,
  outputThreshold = DEFAULT_SHELL_OUTPUT_THRESHOLD,
}: ShellToolDefinitionOptions): ManagedToolDescriptor {
  return {
    ...defineTool(
      ToolNames.SHELL,
      ToolDisplayNames.SHELL,
      getShellToolDescription(shellConfiguration, platform),
      Kind.Execute,
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: getCommandDescription(shellConfiguration),
          },
          is_background: {
            type: 'boolean',
            description:
              'Optional: Whether to run the command in background. If not specified, defaults to false (foreground execution). Explicitly set to true for long-running processes like development servers, watchers, or daemons that should continue running without blocking further commands.',
          },
          timeout: {
            type: 'integer',
            minimum: 1,
            maximum: 600000,
            description: 'Optional timeout in milliseconds (max 600000)',
          },
          description: {
            type: 'string',
            description:
              'Brief description of the command for the user. Be specific and concise. Ideally a single sentence. Can be up to 3 sentences for clarity. No line breaks.',
          },
          directory: {
            type: 'string',
            description:
              '(OPTIONAL) The absolute path of the directory to run the command in. If not provided, the project root directory is used. Must be a directory within the workspace and must already exist.',
          },
        },
        required: ['command'],
      },
      false, // output is not markdown
      true, // output can be updated
    ),
    maxOutputChars: outputThreshold,
  };
}

function getExecutableBasename(executable: string): string {
  return path.basename(path.win32.basename(executable));
}

function getShellDisplayName({
  executable,
  shell,
}: ShellConfiguration): string {
  switch (shell) {
    case 'cmd':
      return 'cmd.exe';
    case 'powershell': {
      const basename = getExecutableBasename(executable).toLowerCase();
      return basename === 'pwsh.exe' ? 'pwsh.exe' : 'powershell.exe';
    }
    case 'bash':
      return 'bash';
    default: {
      const _exhaustive: never = shell;
      return _exhaustive;
    }
  }
}

function getShellExecutionWrapper(
  shellConfiguration: ShellConfiguration,
): string {
  const executable = getShellDisplayName(shellConfiguration);
  return `${executable} ${shellConfiguration.argsPrefix.join(' ')} <command>`;
}

function getShellQuotingGuidance(shell: ShellType): string {
  switch (shell) {
    case 'bash':
      return `- **Shell argument quoting and special characters**: The active shell is Bash. When passing arguments that contain special characters (parentheses \`()\`, backticks \`\`\`\`, dollar signs \`$\`, backslashes \`\\\`, semicolons \`;\`, pipes \`|\`, angle brackets \`<>\`, ampersands \`&\`, exclamation marks \`!\`, etc.), you MUST ensure they are properly quoted to prevent Bash from misinterpreting them as shell syntax:
  - **Single quotes** \`'...'\` pass everything literally, but cannot contain a literal single quote.
  - **ANSI-C quoting** \`$'...'\` supports escape sequences (e.g. \`\\n\` for newline, \`\\'\` for single quote) and is the safest approach for multi-line strings or strings with single quotes.
  - **Heredoc** is the most robust approach for large, multi-line text with mixed quotes:
    \`\`\`bash
    gh pr create --title "My Title" --body "$(cat <<'HEREDOC'
    Multi-line body with (parentheses), \`backticks\`, and 'single-quotes'.
    HEREDOC
    )"
    \`\`\`
  - NEVER use unescaped single quotes inside single-quoted strings (e.g. \`'it\\'s'\` is wrong; use \`$'it\\'s'\` or \`"it's"\` instead).
  - If unsure, prefer double-quoting arguments and escape inner double-quotes as \`\\"\`.`;
    case 'powershell':
      return `- **Shell argument quoting and special characters**: The active shell is PowerShell. When passing arguments that contain special characters (parentheses \`()\`, backticks \`\`\`\`, dollar signs \`$\`, backslashes \`\\\`, semicolons \`;\`, pipes \`|\`, angle brackets \`<>\`, ampersands \`&\`, exclamation marks \`!\`, etc.), you MUST ensure they are properly quoted to prevent PowerShell from misinterpreting them as shell syntax:
  - **Single quotes** \`'...'\` pass everything literally. To include a literal single quote, double it (e.g. \`'it''s'\`).
  - **Double quotes** \`"..."\` expand variables and subexpressions; use them only when that expansion is intended.
  - Escape PowerShell metacharacters with the backtick escape character when they must be literal.
  - For large, multi-line text, prefer a single-quoted here-string (\`@' ... '@\`) so content is not interpolated.
  - Do NOT use Bash-only forms such as ANSI-C quoting (\`$'...'\`) or Bash heredocs.`;
    case 'cmd':
      return `- **Shell argument quoting and special characters**: The active shell is cmd.exe. When passing arguments that contain special characters (parentheses \`()\`, backticks \`\`\`\`, dollar signs \`$\`, backslashes \`\\\`, semicolons \`;\`, pipes \`|\`, angle brackets \`<>\`, ampersands \`&\`, exclamation marks \`!\`, etc.), you MUST ensure they are properly quoted to prevent cmd.exe from misinterpreting them as shell syntax:
  - Use double quotes around arguments that contain spaces or metacharacters.
  - Escape literal cmd.exe metacharacters such as \`&\`, \`|\`, \`<\`, \`>\`, and \`^\` with caret (\`^\`).
  - Single quotes do not quote arguments in cmd.exe.
  - Be careful with \`%VAR%\` environment-variable expansion; avoid literal \`%...%\` unless expansion is intended.
  - Do NOT use Bash-only forms such as ANSI-C quoting (\`$'...'\`) or Bash heredocs.`;
    default: {
      const _exhaustive: never = shell;
      return _exhaustive;
    }
  }
}

function getShellCommandSequencingGuidance({
  executable,
  shell,
}: ShellConfiguration): string {
  const independentGuidance =
    '- If the commands are independent and can run in parallel, make multiple run_shell_command tool calls in a single message. For example, if you need to run "git status" and "git diff", send a single message with two run_shell_command tool calls in parallel.';

  switch (shell) {
    case 'bash':
      return `- When issuing multiple commands:
  ${independentGuidance}
  - If the commands depend on each other and must run sequentially, use a single run_shell_command call with '&&' to chain them together (e.g., \`git add . && git commit -m "message" && git push\`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before run_shell_command for git operations, or git add before git commit), run these operations sequentially instead.
  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
  - DO NOT use newlines to separate commands (newlines are ok in quoted strings).`;
    case 'cmd':
      return `- When issuing multiple commands:
  ${independentGuidance}
  - If the commands depend on each other and must run sequentially, use a single run_shell_command call with '&&' to chain them together (e.g., \`git add . && git commit -m "message" && git push\`).
  - Use '&' only when you need to run commands sequentially but don't care if earlier commands fail.
  - DO NOT use ';' or newlines to separate commands in cmd.exe.`;
    case 'powershell': {
      const executableBasename =
        getExecutableBasename(executable).toLowerCase();
      if (executableBasename === 'pwsh.exe') {
        return `- When issuing multiple commands:
  ${independentGuidance}
  - If the commands depend on each other and must run sequentially, use a single run_shell_command call with '&&' to chain them together (e.g., \`git add . && git commit -m "message" && git push\`).
  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
  - DO NOT use newlines to separate commands (newlines are ok in quoted strings).`;
      }

      return `- When issuing multiple commands:
  ${independentGuidance}
  - Windows PowerShell does not support '&&'. If commands must run sequentially and stop on failure, use explicit PowerShell control flow (for example, check \`$LASTEXITCODE\` before running the next external command) or run the next command only after seeing the previous run_shell_command result.
  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
  - DO NOT use newlines to separate commands (newlines are ok in quoted strings).`;
    }
    default: {
      const _exhaustive: never = shell;
      return _exhaustive;
    }
  }
}

function getShellToolDescription(
  shellConfiguration: ShellConfiguration,
  platform: NodeJS.Platform,
): string {
  const executionWrapper = getShellExecutionWrapper(shellConfiguration);
  const isWindows = platform === 'win32';
  const processGroupNote = isWindows
    ? ''
    : '\n  - Command is executed as a subprocess that leads its own process group. Command process group can be terminated as `kill -- -PGID` or signaled as `kill -s SIGNAL -- -PGID`.';
  const processStopNote =
    '\n  - To stop a background command started by this tool, use `task_stop` when a task id is available. Do not use broad process-name kills such as `kill $(pgrep node)`, `pkill node`, or `killall node`; use a specific PID or process group id where supported.';

  return `Executes a given shell command (as \`${executionWrapper}\`) in a subprocess with optional timeout, ensuring proper handling and security measures.

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

**Usage notes**:
- The command argument is required.
- You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes). For longer commands, use \`is_background: true\` and observe the managed task instead of passing a larger timeout.
- It is very helpful if you write a clear, concise description of what this command does in 5-10 words.

- Avoid using run_shell_command with the \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:
  - File search: Use ${ToolNames.GLOB} (NOT find or ls)
  - Content search: Use ${ToolNames.GREP} (NOT grep or rg)
  - Read files: Use ${ToolNames.READ_FILE} (NOT cat/head/tail)
  - Edit files: Use ${ToolNames.EDIT} (NOT sed/awk)
  - Write files: Use ${ToolNames.WRITE_FILE} (NOT echo >/cat <<EOF)
  - Communication: Output text directly (NOT echo/printf)
${getShellQuotingGuidance(shellConfiguration.shell)}
${getShellCommandSequencingGuidance(shellConfiguration)}
- Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the User explicitly requests it.
  <good-example>
  pytest /foo/bar/tests
  </good-example>
  <bad-example>
  cd /foo/bar && pytest tests
  </bad-example>

**Background vs Foreground Execution:**
- You should decide whether commands should run in background or foreground based on their nature:
- Use background execution (is_background: true) for:
  - Long-running development servers: \`npm run start\`, \`npm run dev\`, \`yarn dev\`, \`bun run start\`
  - Build watchers: \`npm run watch\`, \`webpack --watch\`
  - Database servers: \`mongod\`, \`mysql\`, \`redis-server\`
  - Web servers: \`python -m http.server\`, \`php -S localhost:8000\`
  - Any command expected to run indefinitely until manually stopped
${processGroupNote}${processStopNote}
- Use foreground execution (is_background: false) for:
  - One-time commands: \`ls\`, \`cat\`, \`grep\`
  - Build commands: \`npm run build\`, \`make\`
  - Installation commands: \`npm install\`, \`pip install\`
  - Git operations: \`git commit\`, \`git push\`
  - Test runs: \`npm test\`, \`pytest\`
`;
}

function getCommandDescription(shellConfiguration: ShellConfiguration): string {
  const executionWrapper = getShellExecutionWrapper(shellConfiguration);
  switch (shellConfiguration.shell) {
    case 'cmd':
      return `Exact cmd.exe command to execute as \`${executionWrapper}\``;
    case 'powershell':
      return `Exact PowerShell command to execute as \`${executionWrapper}\``;
    case 'bash':
      return `Exact bash command to execute as \`${executionWrapper}\``;
    default: {
      const _exhaustive: never = shellConfiguration.shell;
      return _exhaustive;
    }
  }
}

export function projectReadFileToolClassifierInput(): string {
  return '';
}

export function projectWriteFileToolClassifierInput(params: {
  file_path?: unknown;
  content?: string;
}): Record<string, unknown> {
  const content = params.content ?? '';
  // The 300-character window lets the classifier inspect hostile content
  // hidden behind a benign prefix in an out-of-workspace write.
  return {
    file_path: params.file_path,
    byte_count: Buffer.byteLength(content, 'utf8'),
    content_preview: content.slice(0, 300),
    content_truncated: content.length > 300,
  };
}

export function projectEditToolClassifierInput(params: {
  file_path?: unknown;
  old_string?: string;
  new_string?: string;
}): Record<string, unknown> {
  const oldStr = params.old_string ?? '';
  const newStr = params.new_string ?? '';
  return {
    file_path: params.file_path,
    old_string_preview: oldStr.slice(0, 300),
    new_string_preview: newStr.slice(0, 300),
    old_string_truncated: oldStr.length > 300,
    new_string_truncated: newStr.length > 300,
    lines_changed:
      (newStr.match(/\n/g)?.length ?? 0) - (oldStr.match(/\n/g)?.length ?? 0),
  };
}

export function projectShellToolClassifierInput(
  params: { command?: unknown; directory?: unknown },
  cwd: string,
): Record<string, unknown> {
  // Safety classification needs the full command.
  return { command: params.command, cwd: params.directory ?? cwd };
}

export function getNotebookEditToolDefinition(): ManagedToolDescriptor {
  return defineTool(
    ToolNames.NOTEBOOK_EDIT,
    ToolDisplayNames.NOTEBOOK_EDIT,
    `Edits a Jupyter notebook (.ipynb) safely at the cell level. Use this instead of ${ToolNames.EDIT} or ${ToolNames.WRITE_FILE} for notebook cells. Supports replacing, inserting, and deleting cells. Always read the notebook first with ${ToolNames.READ_FILE}; then use the cell IDs shown in that output.`,
    Kind.Edit,
    {
      properties: {
        notebook_path: {
          description:
            'Absolute path to the Jupyter notebook file to edit. Must end with .ipynb.',
          type: 'string',
        },
        cell_id: {
          description:
            'Target cell ID from read_file output, or cell-N 0-based fallback. Required for replace and delete. For insert, the new cell is inserted after this cell; if omitted, inserted at the beginning.',
          type: 'string',
        },
        new_source: {
          description:
            'New source content for replace and insert operations. Not required for delete.',
          type: 'string',
        },
        cell_type: {
          description:
            'Cell type for inserted cells or type conversion on replace.',
          type: 'string',
          enum: ['code', 'markdown'],
        },
        edit_mode: {
          description: 'Notebook edit operation. Defaults to replace.',
          type: 'string',
          enum: ['replace', 'insert', 'delete'],
        },
      },
      required: ['notebook_path'],
      additionalProperties: false,
      type: 'object',
    },
  );
}
