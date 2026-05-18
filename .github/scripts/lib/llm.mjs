import { run } from './cli.mjs';

const QWEN_NPX_PACKAGE = '@qwen-code/qwen-code@latest';

export function buildQwenArgs(prompt) {
  return [
    '--yolo',
    '--prompt',
    prompt,
    '--channel=CI',
    '--output-format',
    'json',
  ];
}

export function buildQwenNpxArgs(prompt, env = process.env) {
  return [
    '-y',
    env.QWEN_DESIGN_GATE_NPX_PACKAGE ?? QWEN_NPX_PACKAGE,
    ...buildQwenArgs(prompt),
  ];
}

function extractAssistantText(events) {
  if (!Array.isArray(events)) {
    return typeof events === 'string' ? events : JSON.stringify(events);
  }
  const assistants = events.filter((event) => event.type === 'assistant');
  const last = assistants.at(-1);
  const parts = last?.message?.content ?? [];
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

export function parseJsonFromText(text) {
  const fenced = /```json\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  return JSON.parse(candidate.trim());
}

export function parseQwenOutput(stdout) {
  const parsed = JSON.parse(stdout);
  const text = extractAssistantText(parsed);
  return {
    text,
    json: parseJsonFromText(text),
  };
}

export async function runQwenJson({ prompt, env = process.env } = {}) {
  let stdout;
  try {
    stdout = await run('qwen', buildQwenArgs(prompt), { env });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    stdout = await run('npx', buildQwenNpxArgs(prompt, env), { env });
  }
  return parseQwenOutput(stdout);
}
