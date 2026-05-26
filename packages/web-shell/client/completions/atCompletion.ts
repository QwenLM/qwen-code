import type {
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import { getDaemonAuthHeaders, getDaemonBaseUrl } from '../config/daemon';

export interface AtCompletionOptions {
  baseUrl?: string;
  token?: string;
}

export function createAtCompletionSource(
  opts: AtCompletionOptions = {},
): (
  context: CompletionContext,
) => CompletionResult | null | Promise<CompletionResult | null> {
  return (context) => atCompletionSource(context, opts);
}

export function atCompletionSource(
  context: CompletionContext,
  opts: AtCompletionOptions = {},
): CompletionResult | null | Promise<CompletionResult | null> {
  const line = context.state.doc.lineAt(context.pos);
  const textBefore = line.text.slice(0, context.pos - line.from);

  const match = textBefore.match(/@([\w./-]*)$/);
  if (!match) return null;

  const prefix = match[1];
  const atPos = context.pos - match[0].length;

  return fetchFiles(prefix, opts).then((files) => {
    if (files.length === 0) return null;
    return {
      from: atPos,
      options: files.map((f) => ({
        label: `@${f}`,
        apply: `@${f} `,
      })),
      filter: false,
    };
  });
}

async function fetchFiles(
  prefix: string,
  opts: AtCompletionOptions,
): Promise<string[]> {
  try {
    const pattern = prefix ? `${prefix}*` : '**/*';
    const base = opts.baseUrl || getDaemonBaseUrl() || window.location.origin;
    const headers: HeadersInit = opts.token
      ? { Authorization: `Bearer ${opts.token}` }
      : (getDaemonAuthHeaders() ?? {});
    const res = await fetch(
      `${base}/glob?pattern=${encodeURIComponent(pattern)}&maxResults=50`,
      { headers },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { matches?: unknown[] };
    const matches = Array.isArray(data.matches) ? data.matches : [];
    return matches
      .filter((file): file is string => typeof file === 'string')
      .filter((file) => file !== '.');
  } catch {
    return [];
  }
}
