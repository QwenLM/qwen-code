/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The realtime model's tool surface: seven receipt-style dispatch tools plus
 * remain_silent, with six optional Proactive receipt tools. Descriptions
 * encode the two disciplines every tool obeys: tools return receipts and
 * snapshots (never long-task results — those flow back through injection), and
 * the model must not claim work happened without a receipt.
 */

import {
  REMAIN_SILENT_TOOL_NAME,
  type RealtimeToolDefinition,
} from '../realtime/realtime-session.js';

export const APPSHOT_TOOL_NAME = 'appshot';
export const SESSION_LIST_TOOL_NAME = 'session_list';
export const SESSION_CREATE_TOOL_NAME = 'session_create';
export const HANDOFF_TOOL_NAME = 'handoff';
export const SESSION_MONITOR_TOOL_NAME = 'session_monitor';
export const SESSION_STOP_TOOL_NAME = 'session_stop';
export const RESPOND_PERMISSION_TOOL_NAME = 'respond_permission';
export const CREATE_PROACTIVE_MONITOR_TOOL_NAME = 'create_proactive_monitor';
export const CREATE_LIVE_NARRATION_TOOL_NAME = 'create_live_narration';
export const CREATE_PROACTIVE_TIMER_TOOL_NAME = 'create_proactive_timer';
export const UPDATE_PROACTIVE_TASK_TOOL_NAME = 'update_proactive_task';
export const CANCEL_PROACTIVE_TASK_TOOL_NAME = 'cancel_proactive_task';
export const LIST_PROACTIVE_TASKS_TOOL_NAME = 'list_proactive_tasks';

const PROACTIVE_MODALITIES = {
  type: 'array',
  minItems: 1,
  uniqueItems: true,
  items: { type: 'string', enum: ['vision', 'audio'] },
  description:
    'Evidence channels. Use vision for screen/camera/video/image and audio ' +
    'for microphone/sound/voice. No other value is valid.',
};

const APPSHOT_TOOL: RealtimeToolDefinition = {
  type: 'function',
  continuesResponse: true,
  function: {
    name: APPSHOT_TOOL_NAME,
    description:
      'Capture one current frame from the visual source selected in the ' +
      'Qwen Live orb. Returns source metadata and an asset reference that can ' +
      'be attached to a handoff via input_refs; Screen may also return window ' +
      'and accessibility text. Use this only in On Demand mode when the answer ' +
      'requires current visual information. Never substitute the unselected ' +
      'Screen or Camera source.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

const SESSION_LIST_TOOL: RealtimeToolDefinition = {
  type: 'function',
  continuesResponse: true,
  function: {
    name: SESSION_LIST_TOOL_NAME,
    description:
      'List the coding sessions you can dispatch work to, with their short ' +
      'handles, working directories, whether each is idle or busy, and the ' +
      'backend (coding agent) each runs on. Call this before referring to ' +
      'any session you have not listed yet in this call.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

const SESSION_CREATE_TOOL: RealtimeToolDefinition = {
  type: 'function',
  continuesResponse: true,
  function: {
    name: SESSION_CREATE_TOOL_NAME,
    description:
      'Create a new coding session. Only needed when the user explicitly ' +
      'wants separate parallel workstreams; handoff without a session picks ' +
      'or creates a sensible default on its own. For independent concurrent ' +
      'tasks, create one session per task and hand off to each returned handle.',
    parameters: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Optional human label for the session.',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory for the session.',
        },
        backend: {
          type: 'string',
          description:
            'Optional backend name (a row field of session_list) to run ' +
            'this session on a specific coding agent. Omit for the default.',
        },
      },
      additionalProperties: false,
    },
  },
};

const HANDOFF_TOOL: RealtimeToolDefinition = {
  type: 'function',
  function: {
    name: HANDOFF_TOOL_NAME,
    description:
      "Send the user's request to a coding session for execution. This is " +
      'the default action for anything that touches files, runs commands, ' +
      'needs the screen inspected in depth, or requires up-to-date ' +
      "information. Pass the user's own words in `task`; do not rewrite " +
      'them. Returns a receipt immediately — the result arrives later as a ' +
      '[COMPLETE] context message. Targeting a busy session appends the ' +
      'instruction to its running task or queues it within that session ' +
      '(the receipt says how it landed). Use separate sessions for independent parallel work. ' +
      'Before your first tool call in a user turn, say one short neutral ' +
      'sentence about what you are doing; never promise the outcome.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: "The user's request, in their own words.",
        },
        session: {
          type: 'string',
          description:
            'Target session handle from session_list (e.g. "session_1"). ' +
            'Omit to use the default session.',
        },
        input_refs: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Asset ids to attach (e.g. an appshot screenshot: "asset_1").',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  capturesTranscript: true,
};

const SESSION_MONITOR_TOOL: RealtimeToolDefinition = {
  type: 'function',
  continuesResponse: true,
  function: {
    name: SESSION_MONITOR_TOOL_NAME,
    description:
      'Get a progress snapshot for a session or job (state plus recent ' +
      'activity, including whether it is waiting for permission). Use it ' +
      'only when the user asks how something is going; ' +
      'completed work announces itself without polling.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session handle.' },
        job: { type: 'string', description: 'Job reference (e.g. "job_2").' },
      },
      additionalProperties: false,
    },
  },
};

const SESSION_STOP_TOOL: RealtimeToolDefinition = {
  type: 'function',
  continuesResponse: true,
  function: {
    name: SESSION_STOP_TOOL_NAME,
    description:
      'Cancel the running task in a session. This is the only way to stop ' +
      'work: the user interrupting your speech never cancels tasks. Call it ' +
      'only when the user clearly asks to stop or abandon the work.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session handle.' },
        job: { type: 'string', description: 'Job reference.' },
      },
      additionalProperties: false,
    },
  },
};

const RESPOND_PERMISSION_TOOL: RealtimeToolDefinition = {
  type: 'function',
  continuesResponse: true,
  function: {
    name: RESPOND_PERMISSION_TOOL_NAME,
    description:
      "Relay the user's spoken answer to a pending [PERMISSION] request. " +
      '`allow_always` also lets similar requests through silently for a ' +
      'while. Only call this after the user actually answered; never decide ' +
      'for them. Do not tell the user the vote succeeded until this tool ' +
      'returns status `delivered`.',
    parameters: {
      type: 'object',
      properties: {
        request_id: {
          type: 'string',
          description: 'The id from the [PERMISSION] message (e.g. "req_3").',
        },
        decision: {
          type: 'string',
          enum: ['allow', 'allow_always', 'deny'],
        },
        note: {
          type: 'string',
          description:
            "Optional constraint the user added ('only this file'); it is " +
            'relayed to the coding session together with the vote.',
        },
      },
      required: ['request_id', 'decision'],
      additionalProperties: false,
    },
  },
};

const CREATE_PROACTIVE_MONITOR_TOOL: RealtimeToolDefinition = {
  type: 'function',
  continuesResponse: true,
  function: {
    name: CREATE_PROACTIVE_MONITOR_TOOL_NAME,
    description:
      'Create a NEW condition-based visual-source/microphone monitor for a ' +
      'future observable match, repeated notification, or continuing ' +
      'supervision responsibility. This tool never creates continuous scene ' +
      'narration. Use repeat=false for one future match and true only for ' +
      'explicit recurrence or ongoing supervision. Do not use it for ' +
      'current-scene questions, timers, websites, remote systems, or ' +
      'cumulative counting across windows.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          minLength: 1,
          description: 'Short user-facing task label.',
        },
        modalities: PROACTIVE_MODALITIES,
        condition: {
          type: 'string',
          minLength: 1,
          description:
            'Precise, self-contained future condition observable from the ' +
            "selected media. Describe sensor evidence only, in the user's " +
            'language.',
        },
        trigger_response: {
          type: 'string',
          minLength: 1,
          description:
            'What the user wants the foreground assistant to communicate ' +
            'after a true match: reminder, correction, warning, or ' +
            'encouragement. This is response guidance, not evidence and not ' +
            'exact text to quote.',
        },
        repeat: {
          type: 'boolean',
          description:
            'false for one future match. true only for explicitly repeated ' +
            'notifications or a continuing supervision responsibility; each ' +
            'distinct occurrence rearms only after a later false observation.',
        },
      },
      required: [
        'title',
        'modalities',
        'condition',
        'trigger_response',
        'repeat',
      ],
      additionalProperties: false,
    },
  },
};

const CREATE_LIVE_NARRATION_TOOL: RealtimeToolDefinition = {
  type: 'function',
  continuesResponse: true,
  function: {
    name: CREATE_LIVE_NARRATION_TOOL_NAME,
    description:
      'Create NEW ongoing visual-source/microphone narration only when the ' +
      'user explicitly asks for continuing descriptions. Qwen Live keeps it ' +
      'active until cancelled and publishes only genuinely new observable ' +
      'events or meaningful changes, never every polling window or a ' +
      'condition-based reminder.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          minLength: 1,
          description: 'Short user-facing task label.',
        },
        modalities: PROACTIVE_MODALITIES,
        narration_focus: {
          type: 'string',
          minLength: 1,
          description:
            'The live visual/microphone subject whose new observable events ' +
            'or meaningful changes should be described. It is not a trigger ' +
            'condition.',
        },
        narration_style: {
          type: 'string',
          minLength: 1,
          description:
            'Requested narration language, tone, and level of detail. Use a ' +
            'brief natural style when the user supplied no special ' +
            'preference. Style never changes what counts as new evidence.',
        },
      },
      required: ['title', 'modalities', 'narration_focus', 'narration_style'],
      additionalProperties: false,
    },
  },
};

const CREATE_PROACTIVE_TIMER_TOOL: RealtimeToolDefinition = {
  type: 'function',
  continuesResponse: true,
  function: {
    name: CREATE_PROACTIVE_TIMER_TOOL_NAME,
    description:
      'Create a NEW one-shot device-time reminder after a positive duration. ' +
      'Never use it for visual-source/microphone conditions.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1 },
        duration_sec: { type: 'number', exclusiveMinimum: 0 },
        reminder_text: { type: 'string', minLength: 1 },
      },
      required: ['title', 'duration_sec', 'reminder_text'],
      additionalProperties: false,
    },
  },
};

const UPDATE_PROACTIVE_TASK_TOOL: RealtimeToolDefinition = {
  type: 'function',
  continuesResponse: true,
  function: {
    name: UPDATE_PROACTIVE_TASK_TOOL_NAME,
    description:
      'Modify an existing task selected by a unique title. Event ' +
      'condition/response fields and live-narration focus/style fields are ' +
      'distinct; the task kind cannot be converted by update. Omit the ' +
      'selector only to set repeat=true, with no other arguments, on the ' +
      'immediately adjacent just-created task; every other change needs ' +
      'target_title or target_title_contains. Never use update for a new request.',
    parameters: {
      type: 'object',
      properties: {
        target_title: {
          type: 'string',
          minLength: 1,
          description: 'Exact title of the existing task.',
        },
        target_title_contains: {
          type: 'string',
          minLength: 1,
          description: 'Unique title fragment of the existing task.',
        },
        title: {
          type: 'string',
          minLength: 1,
          description: 'New user-facing title.',
        },
        modalities: PROACTIVE_MODALITIES,
        condition: {
          type: 'string',
          minLength: 1,
          description: 'New observable condition for an event monitor.',
        },
        trigger_response: {
          type: 'string',
          minLength: 1,
          description: 'New spoken response guidance for an event monitor.',
        },
        narration_focus: {
          type: 'string',
          minLength: 1,
          description: 'New live-media focus for an existing narration task.',
        },
        narration_style: {
          type: 'string',
          minLength: 1,
          description:
            'New language, tone, or detail preference for narration.',
        },
        repeat: {
          type: 'boolean',
          description:
            'false for one future match. true only for explicitly repeated ' +
            'notifications or a continuing supervision responsibility; each ' +
            'distinct occurrence rearms only after a later false observation.',
        },
        duration_sec: { type: 'number', exclusiveMinimum: 0 },
        reminder_text: { type: 'string', minLength: 1 },
      },
      minProperties: 1,
      additionalProperties: false,
    },
  },
};

const CANCEL_PROACTIVE_TASK_TOOL: RealtimeToolDefinition = {
  type: 'function',
  continuesResponse: true,
  function: {
    name: CANCEL_PROACTIVE_TASK_TOOL_NAME,
    description:
      'Stop an active Proactive task by a unique exact/partial title, stop ' +
      'all with all=true, or use an empty argument object only for an ' +
      'immediately adjacent reference to the just-created task. Selector-less ' +
      'adjacent cancellation must have no arguments.',
    parameters: {
      type: 'object',
      properties: {
        target_title: { type: 'string', minLength: 1 },
        target_title_contains: { type: 'string', minLength: 1 },
        all: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
};

const LIST_PROACTIVE_TASKS_TOOL: RealtimeToolDefinition = {
  type: 'function',
  continuesResponse: true,
  function: {
    name: LIST_PROACTIVE_TASKS_TOOL_NAME,
    description:
      'Read the authoritative ENTIRE active Proactive task pool before ' +
      'answering which tasks exist or any lifecycle/status question. It is ' +
      'strictly read-only and never mutates, retries, or restarts work. Never ' +
      'infer status from memory, an earlier receipt, ASR, or the absence of a ' +
      'notification.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
};

const REMAIN_SILENT_TOOL: RealtimeToolDefinition = {
  type: 'function',
  function: {
    name: REMAIN_SILENT_TOOL_NAME,
    description:
      'Call this when the best response is to say nothing. Use it instead ' +
      'of speaking after silent context messages whenever acknowledging ' +
      'aloud would be distracting. This tool has no user-visible effect.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

export const LIVE_SESSION_TOOLS: readonly RealtimeToolDefinition[] = [
  APPSHOT_TOOL,
  SESSION_LIST_TOOL,
  SESSION_CREATE_TOOL,
  HANDOFF_TOOL,
  SESSION_MONITOR_TOOL,
  SESSION_STOP_TOOL,
  RESPOND_PERMISSION_TOOL,
  REMAIN_SILENT_TOOL,
];

/** The optional, flat Proactive CRUD surface in provider-visible order. */
export const PROACTIVE_SESSION_TOOLS: readonly RealtimeToolDefinition[] = [
  CREATE_PROACTIVE_MONITOR_TOOL,
  CREATE_LIVE_NARRATION_TOOL,
  CREATE_PROACTIVE_TIMER_TOOL,
  UPDATE_PROACTIVE_TASK_TOOL,
  CANCEL_PROACTIVE_TASK_TOOL,
  LIST_PROACTIVE_TASKS_TOOL,
];

/** Select the foreground tool surface without mutating the compatibility list. */
export function buildLiveSessionTools(
  proactiveEnabled = true,
): readonly RealtimeToolDefinition[] {
  return proactiveEnabled
    ? [...LIVE_SESSION_TOOLS, ...PROACTIVE_SESSION_TOOLS]
    : LIVE_SESSION_TOOLS;
}
