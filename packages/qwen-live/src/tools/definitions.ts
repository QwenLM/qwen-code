/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The realtime model's tool surface: seven receipt-style dispatch tools plus
 * remain_silent. Descriptions encode the two disciplines every tool obeys:
 * tools return receipts and snapshots (never long-task results — those flow
 * back through injection), and the model must not claim work happened
 * without a receipt.
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

const APPSHOT_TOOL: RealtimeToolDefinition = {
  type: 'function',
  function: {
    name: APPSHOT_TOOL_NAME,
    description:
      'Capture what the user currently sees on screen. Returns the frontmost ' +
      'app, window title, and an accessibility-text summary, and registers ' +
      'the screenshot as an asset you can attach to a later handoff via ' +
      'input_refs. Use it whenever the user refers to "this", "the screen", ' +
      'or visible content.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

const SESSION_LIST_TOOL: RealtimeToolDefinition = {
  type: 'function',
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
  function: {
    name: SESSION_CREATE_TOOL_NAME,
    description:
      'Create a new coding session. Only needed when the user explicitly ' +
      'wants separate parallel workstreams; handoff without a session picks ' +
      'or creates a sensible default on its own.',
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
      'instruction to its running task (the receipt says how it landed). ' +
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
  function: {
    name: SESSION_MONITOR_TOOL_NAME,
    description:
      'Get a progress snapshot for a session or job (state plus recent ' +
      'activity). Use it only when the user asks how something is going; ' +
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
  function: {
    name: RESPOND_PERMISSION_TOOL_NAME,
    description:
      "Relay the user's spoken answer to a pending [PERMISSION] request. " +
      '`allow_always` also lets similar requests through silently for a ' +
      'while. Only call this after the user actually answered; never decide ' +
      'for them.',
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
