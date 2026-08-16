// packages/core/src/copilot/copilot-models.ts
import type { CopilotTokenManager } from './copilot-auth.js';
import type { CopilotWire } from './copilot-route.js';
import { routeForModel } from './copilot-route.js';

export interface CopilotModel {
  slug: string;
  wire: CopilotWire;
  contextWindow?: number;
  maxOutput?: number;
}

export async function fetchCopilotModels(
  tokenMgr: CopilotTokenManager,
  opts?: { fetchImpl?: typeof fetch },
): Promise<CopilotModel[] | null> {
  const f = opts?.fetchImpl ?? fetch;
  try {
    const snap = await tokenMgr.getSnapshot();
    const url = `${snap.endpointsApi}/models`;
    const res = await f(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown[] } | unknown[];
    const arr = Array.isArray(body) ? body : body.data;
    if (!Array.isArray(arr)) return null;
    return arr
      .map((entry): CopilotModel | null => {
        if (!entry || typeof entry !== 'object') return null;
        const e = entry as {
          id?: string;
          capabilities?: {
            limits?: {
              max_context_window_tokens?: number;
              max_output_tokens?: number;
            };
          };
        };
        if (typeof e.id !== 'string') return null;
        return {
          slug: e.id,
          wire: routeForModel(e.id),
          contextWindow: e.capabilities?.limits?.max_context_window_tokens,
          maxOutput: e.capabilities?.limits?.max_output_tokens,
        };
      })
      .filter((m): m is CopilotModel => m !== null);
  } catch {
    return null;
  }
}

export async function enableAllCopilotModels(
  tokenMgr: CopilotTokenManager,
  opts?: { fetchImpl?: typeof fetch; modelIds?: string[] },
): Promise<void> {
  const f = opts?.fetchImpl ?? fetch;
  const snap = await tokenMgr.getSnapshot();
  const ids = opts?.modelIds ?? [
    'claude-opus-4.7',
    'claude-sonnet-4.6',
    'gpt-5.2',
  ];
  for (const id of ids) {
    try {
      const res = await f(`${snap.endpointsApi}/models/${id}/policy`, {
        method: 'POST',
        headers: {
          'openai-intent': 'chat-policy',
          'x-interaction-type': 'chat-policy',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state: 'enabled' }),
      });
      if (!res.ok) {
        process.stderr.write(
          `[copilot] warning: could not enable model "${id}" (HTTP ${res.status})\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `[copilot] warning: could not enable model "${id}": ${err}\n`,
      );
    }
  }
}
