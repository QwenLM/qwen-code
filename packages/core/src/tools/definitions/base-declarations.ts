/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Identity registry for all core tools.
 * Sits at the bottom of the dependency tree to prevent circular imports.
 */

// ============================================================================
// SHARED PARAMETER NAMES (used by multiple tools)
// ============================================================================

export const PARAM_FILE_PATH = 'file_path';
export const PARAM_DIR_PATH = 'dir_path';
export const PARAM_PATTERN = 'pattern';
export const PARAM_CASE_SENSITIVE = 'case_sensitive';
export const PARAM_RESPECT_GIT_IGNORE = 'respect_git_ignore';
export const PARAM_RESPECT_GEMINI_IGNORE = 'respect_gemini_ignore';
export const PARAM_FILE_FILTERING_OPTIONS = 'file_filtering_options';
export const PARAM_DESCRIPTION = 'description';

// ============================================================================
// TOOL NAMES & TOOL-SPECIFIC PARAMETER NAMES
// ============================================================================

// -- Glob --
export const GLOB_TOOL_NAME = 'Glob';
// Glob parameter names
export const GLOB_PARAM_PATH = 'path';

// -- Grep --
export const GREP_TOOL_NAME = 'Grep';
// Grep parameter names (ripgrep variant)
export const GREP_PARAM_PATH = 'path';
export const GREP_PARAM_GLOB = 'glob';
export const GREP_PARAM_OUTPUT_MODE = 'output_mode';
export const GREP_PARAM_MINUS_B = '-B';
export const GREP_PARAM_MINUS_A = '-A';
export const GREP_PARAM_MINUS_C = '-C';
export const GREP_PARAM_CONTEXT = 'context';
export const GREP_PARAM_MINUS_N = '-n';
export const GREP_PARAM_MINUS_I = '-i';
export const GREP_PARAM_TYPE = 'type';
export const GREP_PARAM_HEAD_LIMIT = 'head_limit';
export const GREP_PARAM_OFFSET = 'offset';
export const GREP_PARAM_MULTILINE = 'multiline';
// Legacy grep parameter names (used by non-ripgrep Grep variant)
export const GREP_PARAM_INCLUDE_PATTERN = 'include_pattern';
export const GREP_PARAM_EXCLUDE_PATTERN = 'exclude_pattern';
export const GREP_PARAM_NAMES_ONLY = 'names_only';
export const GREP_PARAM_MAX_MATCHES_PER_FILE = 'max_matches_per_file';
export const GREP_PARAM_TOTAL_MAX_MATCHES = 'total_max_matches';
export const GREP_PARAM_FIXED_STRINGS = 'fixed_strings';
export const GREP_PARAM_AFTER = 'after';
export const GREP_PARAM_BEFORE = 'before';
export const GREP_PARAM_NO_IGNORE = 'no_ignore';

// -- Read --
export const READ_FILE_TOOL_NAME = 'Read';
export const READ_FILE_PARAM_OFFSET = 'offset';
export const READ_FILE_PARAM_LIMIT = 'limit';
export const READ_FILE_PARAM_PAGES = 'pages';

// -- Bash --
export const SHELL_TOOL_NAME = 'Bash';
export const POWERSHELL_TOOL_NAME = 'PowerShell';
export const MONITOR_TOOL_NAME = 'Monitor';
export const TASK_STOP_TOOL_NAME = 'TaskStop';
export const BASH_INPUT_TOOL_NAME = 'BashInput';
export const BASH_OUTPUT_TOOL_NAME = 'BashOutput';
export const BASH_RESIZE_TOOL_NAME = 'BashResize';
export const SHELL_PARAM_COMMAND = 'command';
export const SHELL_PARAM_RUN_IN_BACKGROUND = 'run_in_background';

// -- Write --
export const WRITE_FILE_TOOL_NAME = 'Write';
export const WRITE_FILE_PARAM_CONTENT = 'content';

// -- Edit --
export const EDIT_TOOL_NAME = 'Edit';
export const EDIT_PARAM_OLD_STRING = 'old_string';
export const EDIT_PARAM_NEW_STRING = 'new_string';
export const EDIT_PARAM_ALLOW_MULTIPLE = 'allow_multiple';

// -- NotebookEdit --
export const NOTEBOOK_EDIT_TOOL_NAME = 'NotebookEdit';

// -- WebSearch --
export const WEB_SEARCH_TOOL_NAME = 'WebSearch';
export const WEB_SEARCH_PARAM_QUERY = 'query';
export const WEB_SEARCH_PARAM_ALLOWED_DOMAINS = 'allowed_domains';
export const WEB_SEARCH_PARAM_BLOCKED_DOMAINS = 'blocked_domains';

// -- ImageSearch --
export const IMAGE_SEARCH_TOOL_NAME = 'ImageSearch';
export const IMAGE_SEARCH_PARAM_QUERY = 'query';
export const IMAGE_SEARCH_PARAM_COUNT = 'count';

// -- WebFetch --
export const WEB_FETCH_PARAM_URL = 'url';
export const WEB_FETCH_TOOL_NAME = 'WebFetch';
export const WEB_FETCH_PARAM_PROMPT = 'prompt';

// -- TodoWrite --
export const WRITE_TODOS_TOOL_NAME = 'TodoWrite';
export const TODOS_PARAM_TODOS = 'todos';
export const TODOS_ITEM_PARAM_DESCRIPTION = 'description';
export const TODOS_ITEM_PARAM_STATUS = 'status';

// -- Skill --
export const SKILL_TOOL_NAME = 'Skill';
export const SKILL_PARAM_NAME = 'skill';

// -- AskUserQuestion --
export const ASK_USER_TOOL_NAME = 'AskUserQuestion';
export const ASK_USER_PARAM_QUESTIONS = 'questions';
export const ASK_USER_PARAM_ANSWERS = 'answers';
export const ASK_USER_PARAM_ANNOTATIONS = 'annotations';
export const ASK_USER_PARAM_METADATA = 'metadata';
// AskUserQuestion question item params
export const ASK_USER_QUESTION_PARAM_QUESTION = 'question';
export const ASK_USER_QUESTION_PARAM_HEADER = 'header';
export const ASK_USER_QUESTION_PARAM_OPTIONS = 'options';
export const ASK_USER_QUESTION_PARAM_MULTI_SELECT = 'multiSelect';
// AskUserQuestion option item params
export const ASK_USER_OPTION_PARAM_LABEL = 'label';
export const ASK_USER_OPTION_PARAM_DESCRIPTION = 'description';
export const ASK_USER_OPTION_PARAM_PREVIEW = 'preview';

// -- ExitPlanMode --
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode';
/** @deprecated plan_filename parameter has been removed; path is now derived automatically. */
export const EXIT_PLAN_PARAM_PLAN_FILENAME = 'plan_filename';

// -- EnterPlanMode --
export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode';
export const PLAN_MODE_PARAM_REASON = 'reason';

// -- UpdateTopic --
export const UPDATE_TOPIC_TOOL_NAME = 'UpdateTopic';
export const UPDATE_TOPIC_DISPLAY_NAME = 'UpdateTopic';
export const TOPIC_PARAM_TITLE = 'title';
export const TOPIC_PARAM_SUMMARY = 'summary';
export const TOPIC_PARAM_STRATEGIC_INTENT = 'strategic_intent';

// -- Agent (unified subagent tool) --
export const AGENT_TOOL_NAME = 'Agent';
export const SEND_MESSAGE_TOOL_NAME = 'SendMessage';

// -- EnterWorktree --
export const ENTER_WORKTREE_TOOL_NAME = 'EnterWorktree';

// -- ExitWorktree --
export const EXIT_WORKTREE_TOOL_NAME = 'ExitWorktree';

// -- CompleteTask --
export const COMPLETE_TASK_TOOL_NAME = 'CompleteTask';
export const COMPLETE_TASK_DISPLAY_NAME = 'CompleteTask';

// -- ImageGen --
export const IMAGE_GEN_TOOL_NAME = 'ImageGen';
export const IMAGE_GEN_PARAM_NAME = 'name';
export const IMAGE_GEN_PARAM_PROMPT = 'prompt';
export const IMAGE_GEN_PARAM_SIZE = 'size';

// -- VideoGen --
export const VIDEO_GEN_TOOL_NAME = 'VideoGen';
export const VIDEO_GEN_DISPLAY_NAME = 'VideoGen';
export const VIDEO_GEN_PARAM_NAME = 'name';
export const VIDEO_GEN_PARAM_MODE = 'mode';
export const VIDEO_GEN_PARAM_PROMPT = 'prompt';
export const VIDEO_GEN_PARAM_MEDIA = 'media';
export const VIDEO_GEN_PARAM_SIZE = 'size';
export const VIDEO_GEN_PARAM_DURATION_SECONDS = 'duration_seconds';
export const VIDEO_GEN_PARAM_DELIVERY = 'delivery';

// -- VideoGenRetrieve --
export const VIDEO_GEN_RETRIEVE_TOOL_NAME = 'VideoGenRetrieve';
export const VIDEO_GEN_RETRIEVE_DISPLAY_NAME = 'VideoGenRetrieve';
export const VIDEO_GEN_RETRIEVE_PARAM_VIDEO_ID = 'video_id';

// -- CodebaseInvestigator --
export const CODEBASE_INVESTIGATOR_TOOL_NAME = 'CodebaseInvestigator';

// -- Goal tools --
export const GET_GOAL_TOOL_NAME = 'GetGoal';
export const CREATE_GOAL_TOOL_NAME = 'CreateGoal';
export const UPDATE_GOAL_TOOL_NAME = 'UpdateGoal';

// -- Cron tools --
export const CRON_CREATE_TOOL_NAME = 'CronCreate';
export const CRON_DELETE_TOOL_NAME = 'CronDelete';
export const CRON_LIST_TOOL_NAME = 'CronList';
export const SCHEDULE_WAKEUP_TOOL_NAME = 'ScheduleWakeup';

// -- Task list tools --
export const TASK_CREATE_TOOL_NAME = 'TaskCreate';
export const TASK_GET_TOOL_NAME = 'TaskGet';
export const TASK_UPDATE_TOOL_NAME = 'TaskUpdate';
export const TASK_LIST_TOOL_NAME = 'TaskList';
