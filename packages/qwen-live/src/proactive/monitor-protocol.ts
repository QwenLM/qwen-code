/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted to TypeScript from qwen-omni-realtime-agent; modified for Qwen Live.
 */

export type ProactiveMonitorMode = 'event' | 'always';

export interface MonitorEvaluationResult {
  triggered: boolean;
  summary: string;
  currentState: string;
  error?: string;
  ignoredAction?: 'function_call';
}

export interface MonitorInstructionSource {
  title: string;
  taskDescription: string;
  monitorMode: ProactiveMonitorMode;
  narrationStyle?: string;
}

export interface ProactiveEventFields {
  taskId: string;
  deliveryId: string;
  title: string;
  taskType: 'perception_monitor' | 'time_reminder';
  summary: string;
  sourceModalities: readonly string[];
  interventionText: string;
  monitorMode: ProactiveMonitorMode;
}

const CURRENT_STATE_MAX_CHARS = 500;

const NARRATION_FILLER_PREFIX =
  /^(?:好的|嗯+|收到(?:了)?|okay|ok|got\s+it)[\s，,。.!！?？、:：;；~～-]*/iu;
const NARRATION_PERCEPTION_PREFIX =
  /^(?:我(?:刚刚|刚才|现在)?(?:看到|看见|注意到|发现|听到|听见)(?:了)?|i\s+(?:can\s+)?(?:see|saw|hear|heard|noticed|notice|observed|observe))[\s，,。.!！?？、:：;；~～-]*/iu;

/**
 * The source DashScope SFT prompt, including its original tool catalogue.
 * Proposed calls remain non-executable compatibility actions.
 */
export const PROACTIVE_MONITOR_SYSTEM_PROMPT = `You are a proactive real-time assistant monitoring a live stream delivered as sequential short clips. Each clip may contain audio, video, or both. The user may provide an instruction at the start and further task-related instructions or questions during the session.

After each clip, use only the evidence available up to the end of that clip and output EXACTLY one of the following:

- \`wait\`
- \`Reply: <response>\`
- A tool call, written as one acknowledgment line followed by one JSON line:
  \`Func_call:<acknowledgment in the user's language>\`
  \`{"name": "<tool name>", "intent": "<natural-language intent>"}\`

Do not output anything else. Do not use markdown or code fences. Do not combine \`Reply:\` and \`Func_call:\` in one turn.

# Policy

- Follow the user's current task. By default, monitor the stream and respond when notification, guidance, correction, confirmation, or an answer is needed.
- Use narration only when the user explicitly requests it. Report only information that becomes clear in the current clip. If several updates occur, present them in chronological order.
- Output \`wait\` when no response is needed or the evidence is insufficient. Do not predict or use future clips.
- A session may require multiple responses. Continue monitoring after each response.
- Use the user's language. Keep \`Reply:\` focused on the current need, usually in one sentence.
- Do not repeat a response unless the state changes or the user continues an error that requires another correction.
- Use \`Func_call:\` only when an allowed tool is needed. If no listed tool fits, use \`Reply:\`.

# Available tools — use names exactly as written

- generate_html_slides: Generate ONE presentation slide as self-contained HTML for the current topic. Emit one call per page as the talk or tutorial progresses.
- yxbj-mcp-save-note: Save a running meeting or lecture minute as a note to Yinxiang (Evernote). Emit one call per topic or section as it concludes.
- Notion-append-blocks: Append newly summarized content blocks to a Notion page. Emit one call per completed section.
- mind-map-generate_mindmap: Generate or refresh a mind map from accumulated key points when a coherent branch has been covered.
- mcp-server-hotnews-get_hot_news: Fetch current hot or trending lists from Chinese platforms including Zhihu, 36Kr, Baidu, Bilibili, Weibo, Douyin, Hupu, Douban, and IT platforms.
- trends-hub-get-douyin-trending: Get the Douyin trending list.
- trends-hub-get-douban-rank: Get Douban rankings for books, movies, or TV.
- trends-hub-get-weibo-trending: Get the Weibo hot-search list.
- trends-hub-get-zhihu-trending: Get the Zhihu trending list.
- trends-hub-get-bilibili-rank: Get Bilibili video rankings by partition.
- trends-hub-get-weread-rank: Get the WeRead book ranking.
- variflight-searchFlightsByDepArr: Look up flights or status between airports on a specified date.
- redash-execute_adhoc_query: Run an ad-hoc SQL query against a Redash data source when a concrete SQL or data question is stated.
- mcp-server-weread-search_books: Search WeRead by book title, author, or category.
- foodnearby-mcp-search_map_poi: Search nearby food or restaurant POIs via AMap.
- dingtalk-mcp-createEvent: Create a DingTalk calendar event when a concrete meeting or appointment time is agreed.
- 12306-mcp-get-tickets: Search 12306 train tickets for a concrete China-rail trip.
- tongchenglvxing-mcp-server-query_train_tickets_list: Search train tickets via Tongcheng for a concrete China-rail trip.`;

export function buildMonitorInstruction(
  source: MonitorInstructionSource,
): string {
  const focus = source.taskDescription.trim() || source.title.trim();
  const lines = focus ? [focus] : [];
  if (source.monitorMode === 'always' && source.narrationStyle?.trim()) {
    lines.push(source.narrationStyle.trim());
  }
  return lines.join('\n');
}

function normalizeNarrationSummary(value: string): string {
  let normalized = value.trim();
  for (let index = 0; index < 4; index += 1) {
    const next = normalized
      .replace(NARRATION_FILLER_PREFIX, '')
      .replace(NARRATION_PERCEPTION_PREFIX, '')
      .replace(/^[\s，,。.!！?？、:：;；~～-]+/u, '');
    if (next === normalized) break;
    normalized = next;
  }
  return normalized.trim();
}

function normalizeCurrentState(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').slice(0, CURRENT_STATE_MAX_CHARS);
}

export function parseMonitorAction(
  raw: string,
  monitorMode: ProactiveMonitorMode,
): MonitorEvaluationResult {
  const action = raw.trim();
  if (action === 'wait') {
    return { triggered: false, summary: '', currentState: '' };
  }
  if (action.startsWith('Func_call:')) {
    if (!action.slice('Func_call:'.length).trim()) {
      throw new Error('Func_call action requires a non-empty body.');
    }
    return {
      triggered: false,
      summary: '',
      currentState: '',
      ignoredAction: 'function_call',
    };
  }
  if (!action.startsWith('Reply:')) {
    throw new Error(
      "Monitor action must be exactly 'wait' or start with 'Reply:' or 'Func_call:'.",
    );
  }
  const reply = action.slice('Reply:'.length).trim();
  if (!reply) throw new Error('Reply action requires a non-empty response.');
  const summary =
    monitorMode === 'always' ? normalizeNarrationSummary(reply) : reply;
  if (!summary) return { triggered: false, summary: '', currentState: '' };
  return {
    triggered: true,
    summary,
    currentState:
      monitorMode === 'always' ? normalizeCurrentState(summary) : '',
  };
}

export function formatProactiveEvent(fields: ProactiveEventFields): string {
  return `[PROACTIVE_EVENT]\n${JSON.stringify(
    {
      event_type:
        fields.monitorMode === 'always' ? 'narration_update' : 'task_triggered',
      task_id: fields.taskId,
      title: fields.title,
      task_type: fields.taskType,
      summary: fields.summary,
      source_modalities: fields.sourceModalities,
      intervention_text: fields.interventionText,
      monitor_mode: fields.monitorMode,
      delivery_id: fields.deliveryId,
    },
    null,
    2,
  )}\n[/PROACTIVE_EVENT]`;
}
