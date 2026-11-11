/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Full tool manifest — the single, unified tool set for all models.
 * Includes complete descriptions and schemas for auditing in one place.
 */

import type { CoreToolSet } from '../types.js';
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  ASK_USER_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  // Shared parameter names
  PARAM_FILE_PATH,
  PARAM_DIR_PATH,
  PARAM_PATTERN,
  // Grep/glob parameter names (ripgrep variant)
  GLOB_PARAM_PATH,
  GREP_PARAM_PATH,
  GREP_PARAM_GLOB,
  GREP_PARAM_OUTPUT_MODE,
  GREP_PARAM_MINUS_B,
  GREP_PARAM_MINUS_A,
  GREP_PARAM_MINUS_C,
  GREP_PARAM_CONTEXT,
  GREP_PARAM_MINUS_N,
  GREP_PARAM_MINUS_I,
  GREP_PARAM_TYPE,
  GREP_PARAM_HEAD_LIMIT,
  GREP_PARAM_OFFSET,
  GREP_PARAM_MULTILINE,
  // Legacy grep parameter names (non-ripgrep grep_search variant)
  GREP_PARAM_INCLUDE_PATTERN,
  GREP_PARAM_EXCLUDE_PATTERN,
  GREP_PARAM_NAMES_ONLY,
  GREP_PARAM_MAX_MATCHES_PER_FILE,
  GREP_PARAM_TOTAL_MAX_MATCHES,
  // Tool-specific parameter names
  READ_FILE_PARAM_OFFSET,
  READ_FILE_PARAM_LIMIT,
  READ_FILE_PARAM_PAGES,
  WRITE_FILE_PARAM_CONTENT,
  EDIT_PARAM_OLD_STRING,
  EDIT_PARAM_NEW_STRING,
  EDIT_PARAM_ALLOW_MULTIPLE,
  WEB_FETCH_PARAM_PROMPT,
  WEB_FETCH_PARAM_URL,
  TODOS_PARAM_TODOS,
  TODOS_ITEM_PARAM_DESCRIPTION,
  TODOS_ITEM_PARAM_STATUS,
  ASK_USER_PARAM_QUESTIONS,
  ASK_USER_PARAM_ANSWERS,
  ASK_USER_PARAM_ANNOTATIONS,
  ASK_USER_PARAM_METADATA,
  ASK_USER_QUESTION_PARAM_QUESTION,
  ASK_USER_QUESTION_PARAM_HEADER,
  ASK_USER_QUESTION_PARAM_OPTIONS,
  ASK_USER_QUESTION_PARAM_MULTI_SELECT,
  ASK_USER_OPTION_PARAM_LABEL,
  ASK_USER_OPTION_PARAM_DESCRIPTION,
  ASK_USER_OPTION_PARAM_PREVIEW,
  PLAN_MODE_PARAM_REASON,
} from '../base-declarations.js';
import {
  getShellDeclaration,
  getExitPlanModeDeclaration,
  getActivateSkillDeclaration,
} from '../dynamic-declaration-helpers.js';
import {
  getReadFileDescription,
  getWriteFileDescription,
  getReplaceDescription,
  getGlobDescription,
  getGrepLegacyDescription,
  getGrepRipgrepDescription,
  getWebFetchDescription,
  getAskUserDescription,
  getEnterPlanModeDescription,
} from '../tool-prompts/index.js';

export const CORE_TOOL_SET: CoreToolSet = {
  Read: {
    name: READ_FILE_TOOL_NAME,
    description: getReadFileDescription(),
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [PARAM_FILE_PATH]: {
          description: 'The absolute path to the file to read',
          type: 'string',
        },
        [READ_FILE_PARAM_OFFSET]: {
          description:
            'The line number to start reading from. Only provide if the file is too large to read at once',
          type: 'number',
        },
        [READ_FILE_PARAM_LIMIT]: {
          description:
            'The number of lines to read. Only provide if the file is too large to read at once.',
          type: 'number',
        },
        [READ_FILE_PARAM_PAGES]: {
          description:
            'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.',
          type: 'string',
        },
      },
      required: [PARAM_FILE_PATH],
    },
  },

  Write: {
    name: WRITE_FILE_TOOL_NAME,
    description: getWriteFileDescription(),
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [PARAM_FILE_PATH]: {
          description: 'The absolute path to the file to write to',
          type: 'string',
        },
        [WRITE_FILE_PARAM_CONTENT]: {
          description:
            "The content to write to the file. Do not use omission placeholders like '(rest of methods ...)', '...', or 'unchanged code'; provide complete literal content.",
          type: 'string',
        },
      },
      required: [PARAM_FILE_PATH, WRITE_FILE_PARAM_CONTENT],
    },
  },

  Grep: {
    name: GREP_TOOL_NAME,
    description: getGrepLegacyDescription(),
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [PARAM_PATTERN]: {
          description: `The regular expression (regex) pattern to search for within file contents (e.g., 'function\\s+myFunction', 'import\\s+\\{.*\\}\\s+from\\s+.*').`,
          type: 'string',
        },
        [PARAM_DIR_PATH]: {
          description:
            'Optional: The absolute path to the directory to search within. If omitted, searches the current working directory and all trusted directories.',
          type: 'string',
        },
        [GREP_PARAM_INCLUDE_PATTERN]: {
          description: `Optional: A glob pattern to filter which files are searched (e.g., '*.js', '*.{ts,tsx}', 'src/**'). If omitted, searches all files (respecting potential global ignores).`,
          type: 'string',
        },
        [GREP_PARAM_EXCLUDE_PATTERN]: {
          description:
            'Optional: A regular expression pattern to exclude from the search results. If a line matches both the pattern and the exclude_pattern, it will be omitted.',
          type: 'string',
        },
        [GREP_PARAM_NAMES_ONLY]: {
          description:
            'Optional: If true, only the file paths of the matches will be returned, without the line content or line numbers. This is useful for gathering a list of files.',
          type: 'boolean',
        },
        [GREP_PARAM_MAX_MATCHES_PER_FILE]: {
          description:
            'Optional: Maximum number of matches to return per file. Use this to prevent being overwhelmed by repetitive matches in large files.',
          type: 'integer',
          minimum: 1,
        },
        [GREP_PARAM_TOTAL_MAX_MATCHES]: {
          description:
            'Optional: Maximum number of total matches to return. Use this to limit the overall size of the response. Defaults to 100 if omitted.',
          type: 'integer',
          minimum: 1,
        },
      },
      required: [PARAM_PATTERN],
    },
  },

  GrepRipgrep: {
    name: GREP_TOOL_NAME,
    description: getGrepRipgrepDescription(),
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [PARAM_PATTERN]: {
          description:
            'The regular expression pattern to search for in file contents',
          type: 'string',
        },
        [GREP_PARAM_PATH]: {
          description:
            'File or directory to search in (rg PATH). Defaults to the current working directory.',
          type: 'string',
        },
        [GREP_PARAM_GLOB]: {
          description:
            'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
          type: 'string',
        },
        [GREP_PARAM_OUTPUT_MODE]: {
          description:
            'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
        },
        [GREP_PARAM_MINUS_B]: {
          description:
            'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
          type: 'number',
        },
        [GREP_PARAM_MINUS_A]: {
          description:
            'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
          type: 'number',
        },
        [GREP_PARAM_MINUS_C]: {
          description: 'Alias for context.',
          type: 'number',
        },
        [GREP_PARAM_CONTEXT]: {
          description:
            'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
          type: 'number',
        },
        [GREP_PARAM_MINUS_N]: {
          description:
            'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
          type: 'boolean',
        },
        [GREP_PARAM_MINUS_I]: {
          description: 'Case insensitive search (rg -i)',
          type: 'boolean',
        },
        '-o': {
          description:
            'Print only matched non-empty parts, one match per line (rg -o). Requires output_mode: "content", ignored otherwise.',
          type: 'boolean',
        },
        [GREP_PARAM_TYPE]: {
          description:
            'File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.',
          type: 'string',
        },
        [GREP_PARAM_HEAD_LIMIT]: {
          description:
            'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).',
          type: 'number',
        },
        [GREP_PARAM_OFFSET]: {
          description:
            'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
          type: 'number',
        },
        [GREP_PARAM_MULTILINE]: {
          description:
            'Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.',
          type: 'boolean',
        },
      },
      required: [PARAM_PATTERN],
      additionalProperties: false,
    },
  },

  Glob: {
    name: GLOB_TOOL_NAME,
    description: getGlobDescription(),
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [PARAM_PATTERN]: {
          description: 'The glob pattern to match files against',
          type: 'string',
        },
        [GLOB_PARAM_PATH]: {
          description:
            'The directory to search in. If not specified, the current working directory will be searched. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
          type: 'string',
        },
      },
      required: [PARAM_PATTERN],
      additionalProperties: false,
    },
  },

  Bash: () => getShellDeclaration(),

  Edit: {
    name: EDIT_TOOL_NAME,
    description: getReplaceDescription(),
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [PARAM_FILE_PATH]: {
          description: 'The absolute path to the file to modify',
          type: 'string',
        },
        [EDIT_PARAM_OLD_STRING]: {
          description: 'The text to replace',
          type: 'string',
        },
        [EDIT_PARAM_NEW_STRING]: {
          description:
            "The exact literal text to replace `old_string` with, preferably unescaped. Provide the EXACT text. Ensure the resulting code is correct and idiomatic. Do not use omission placeholders like '(rest of methods ...)', '...', or 'unchanged code'; provide exact literal code.",
          type: 'string',
        },
        [EDIT_PARAM_ALLOW_MULTIPLE]: {
          type: 'boolean',
          description:
            'If true, the tool will replace all occurrences of `old_string`. If false (default), it will only succeed if exactly one occurrence is found.',
        },
      },
      required: [PARAM_FILE_PATH, EDIT_PARAM_OLD_STRING, EDIT_PARAM_NEW_STRING],
    },
  },

  WebFetch: {
    name: WEB_FETCH_TOOL_NAME,
    description: getWebFetchDescription(),
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [WEB_FETCH_PARAM_URL]: {
          type: 'string',
          description:
            'The URL to fetch content from. Must be a valid http or https URL.',
        },
        [WEB_FETCH_PARAM_PROMPT]: {
          description:
            'The prompt describing what information you want to extract from the page.',
          type: 'string',
        },
      },
      required: [WEB_FETCH_PARAM_URL, WEB_FETCH_PARAM_PROMPT],
    },
  },

  TodoWrite: {
    name: WRITE_TODOS_TOOL_NAME,
    description: `This tool can help you list out the current subtasks that are required to be completed for a given user request. The list of subtasks helps you keep track of the current task, organize complex queries and help ensure that you don't miss any steps. With this list, the user can also see the current progress you are making in executing a given task.

Depending on the task complexity, you should first divide a given task into subtasks and then use this tool to list out the subtasks that are required to be completed for a given user request.
Each of the subtasks should be clear and distinct.

Use this tool for complex queries that require multiple steps. If you find that the request is actually complex after you have started executing the user task, create a todo list and use it. If execution of the user task requires multiple steps, planning and generally is higher complexity than a simple Q&A, use this tool.

DO NOT use this tool for simple tasks that can be completed in less than 2 steps. If the user query is simple and straightforward, do not use the tool. If you can respond with an answer in a single turn then this tool is not required.

## Task state definitions

- pending: Work has not begun on a given subtask.
- in_progress: Marked just prior to beginning work on a given subtask. You should only have one subtask as in_progress at a time.
- completed: Subtask was successfully completed with no errors or issues. If the subtask required more steps to complete, update the todo list with the subtasks. All steps should be identified as completed only when they are completed.
- cancelled: As you update the todo list, some tasks are not required anymore due to the dynamic nature of the task. In this case, mark the subtasks as cancelled.
- blocked: Subtask is blocked and cannot be completed at this time.


## Methodology for using this tool
1. Use this todo list as soon as you receive a user request based on the complexity of the task.
2. Keep track of every subtask that you update the list with.
3. Mark a subtask as in_progress before you begin working on it. You should only have one subtask as in_progress at a time.
4. Update the subtask list as you proceed in executing the task. The subtask list is not static and should reflect your progress and current plans, which may evolve as you acquire new information.
5. Mark a subtask as completed when you have completed it.
6. Mark a subtask as cancelled if the subtask is no longer needed.
7. You must update the todo list as soon as you start, stop or cancel a subtask. Don't batch or wait to update the todo list.


## Examples of When to Use the Todo List

<example>
User request: Create a website with React for creating fancy logos using an image generation model

ToDo list created by the agent:
1. Initialize a new React project environment (e.g., using Vite).
2. Design and build the core UI components: a text input (prompt field) for the logo description, selection controls for style parameters (if the API supports them), and an image preview area.
3. Implement state management (e.g., React Context or Zustand) to manage the user's input prompt, the API loading status (pending, success, error), and the resulting image data.
4. Create an API service module within the React app (using "fetch" or "axios") to securely format and send the prompt data via an HTTP POST request to the configured image generation endpoint.
5. Implement asynchronous logic to handle the API call: show a loading indicator while the request is pending, retrieve the generated image (e.g., as a URL or base64 string) upon success, and display any errors.
6. Display the returned "fancy logo" from the API response in the preview area component.
7. Add functionality (e.g., a "Download" button) to allow the user to save the generated image file.
8. Deploy the application to a web server or hosting platform.

<reasoning>
The agent used the todo list to break the task into distinct, manageable steps:
1. Building an entire interactive web application from scratch is a highly complex, multi-stage process involving setup, UI development, logic integration, and deployment.
2. The agent inferred the core functionality required for a "logo creator," such as UI controls for customization (Task 3) and an export feature (Task 7), which must be tracked as distinct goals.
3. The agent rightly inferred the requirement of an API service model for interacting with the image model endpoint.
</reasoning>
</example>


## Examples of When NOT to Use the Todo List

<example>
User request: Ensure that the test <test file> passes.

Agent:
<Goes into a loop of running the test, identifying errors, and updating the code until the test passes.>

<reasoning>
The agent did not use the todo list because this task could be completed by a tight loop of execute test->edit->execute test.
</reasoning>
</example>`,
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [TODOS_PARAM_TODOS]: {
          type: 'array',
          description:
            'The complete list of todo items. This will replace the existing list.',
          items: {
            type: 'object',
            description: 'A single todo item.',
            properties: {
              [TODOS_ITEM_PARAM_DESCRIPTION]: {
                type: 'string',
                description: 'The description of the task.',
              },
              [TODOS_ITEM_PARAM_STATUS]: {
                type: 'string',
                description: 'The current status of the task.',
                enum: [
                  'pending',
                  'in_progress',
                  'completed',
                  'cancelled',
                  'blocked',
                ],
              },
            },
            required: [TODOS_ITEM_PARAM_DESCRIPTION, TODOS_ITEM_PARAM_STATUS],
            additionalProperties: false,
          },
        },
      },
      required: [TODOS_PARAM_TODOS],
      additionalProperties: false,
    },
  },

  AskUserQuestion: {
    name: ASK_USER_TOOL_NAME,
    description: getAskUserDescription(),
    parametersJsonSchema: {
      type: 'object',
      required: [ASK_USER_PARAM_QUESTIONS],
      additionalProperties: false,
      properties: {
        [ASK_USER_PARAM_QUESTIONS]: {
          type: 'array',
          description: 'Questions to ask the user (1-4 questions)',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            required: [
              ASK_USER_QUESTION_PARAM_QUESTION,
              ASK_USER_QUESTION_PARAM_HEADER,
              ASK_USER_QUESTION_PARAM_OPTIONS,
            ],
            properties: {
              [ASK_USER_QUESTION_PARAM_QUESTION]: {
                type: 'string',
                description:
                  'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
              },
              [ASK_USER_QUESTION_PARAM_HEADER]: {
                type: 'string',
                description:
                  'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
              },
              [ASK_USER_QUESTION_PARAM_OPTIONS]: {
                type: 'array',
                description:
                  "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  required: [
                    ASK_USER_OPTION_PARAM_LABEL,
                    ASK_USER_OPTION_PARAM_DESCRIPTION,
                  ],
                  properties: {
                    [ASK_USER_OPTION_PARAM_LABEL]: {
                      type: 'string',
                      description:
                        'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.',
                    },
                    [ASK_USER_OPTION_PARAM_DESCRIPTION]: {
                      type: 'string',
                      description:
                        'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.',
                    },
                    [ASK_USER_OPTION_PARAM_PREVIEW]: {
                      type: 'string',
                      description:
                        'Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.',
                    },
                  },
                },
              },
              [ASK_USER_QUESTION_PARAM_MULTI_SELECT]: {
                type: 'boolean',
                default: false,
                description:
                  'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.',
              },
            },
          },
        },
        [ASK_USER_PARAM_ANSWERS]: {
          type: 'object',
          description: 'User answers collected by the permission component',
          additionalProperties: {
            type: 'string',
          },
        },
        [ASK_USER_PARAM_ANNOTATIONS]: {
          type: 'object',
          description:
            'Optional per-question annotations from the user (e.g., notes on preview selections). Keyed by question text.',
          additionalProperties: {
            type: 'object',
            properties: {
              preview: {
                type: 'string',
                description:
                  'The preview content of the selected option, if the question used previews.',
              },
              notes: {
                type: 'string',
                description:
                  'Free-text notes the user added to their selection.',
              },
            },
          },
        },
        [ASK_USER_PARAM_METADATA]: {
          type: 'object',
          description:
            'Optional metadata for tracking and analytics purposes. Not displayed to user.',
          properties: {
            source: {
              type: 'string',
              description:
                'Optional identifier for the source of this question (e.g., "remember" for /remember command). Used for analytics tracking.',
            },
          },
        },
      },
    },
  },

  EnterPlanMode: {
    name: ENTER_PLAN_MODE_TOOL_NAME,
    description: getEnterPlanModeDescription(),
    parametersJsonSchema: {
      type: 'object',
      properties: {
        [PLAN_MODE_PARAM_REASON]: {
          type: 'string',
          description:
            'Short reason explaining why you are entering plan mode.',
        },
      },
    },
  },

  ExitPlanMode: () => getExitPlanModeDeclaration(),

  Skill: () => getActivateSkillDeclaration(),
};
