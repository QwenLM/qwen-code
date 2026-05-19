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

function snippet(value) {
  const text = typeof value === 'string' ? value : String(value);
  return text.length > 600 ? `${text.slice(0, 600)}…[truncated]` : text;
}

export function parseJsonFromText(text) {
  const fenced = /```json\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch (error) {
    // A bare "Unexpected token" with no context makes CI failures
    // impossible to diagnose; include what the model actually returned.
    throw new Error(
      `Failed to parse JSON from LLM output: ${error.message}. Raw text: ${snippet(text)}`,
    );
  }
}

export function parseQwenOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Failed to parse qwen --output-format json stdout: ${error.message}. Raw stdout: ${snippet(stdout)}`,
    );
  }
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
