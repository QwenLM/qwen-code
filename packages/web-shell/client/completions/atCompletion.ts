import type {
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import { getDaemonAuthHeaders } from '../config/daemon';

export function atCompletionSource(
  context: CompletionContext,
): CompletionResult | null | Promise<CompletionResult | null> {
  const line = context.state.doc.lineAt(context.pos);
  const textBefore = line.text.slice(0, context.pos - line.from);

  const match = textBefore.match(/@([\w./-]*)$/);
  if (!match) return null;

  const prefix = match[1];
  const atPos = context.pos - match[0].length;

  return fetchFiles(prefix).then((files) => {
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

async function fetchFiles(prefix: string): Promise<string[]> {
  try {
    const pattern = prefix ? `${prefix}*` : '**/*';
    const res = await fetch(
      `/glob?pattern=${encodeURIComponent(pattern)}&maxResults=50`,
      { headers: getDaemonAuthHeaders() },
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
