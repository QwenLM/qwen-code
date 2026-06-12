import type {
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';

export type GlobFn = (
  pattern: string,
  opts?: { maxResults?: number },
) => Promise<{ matches: string[] }>;

export function createAtCompletionSource(
  getGlob: () => GlobFn | undefined,
): (
  context: CompletionContext,
) => CompletionResult | null | Promise<CompletionResult | null> {
  return (context) => atCompletionSource(context, getGlob);
}

export function atCompletionSource(
  context: CompletionContext,
  getGlob: () => GlobFn | undefined,
): CompletionResult | null | Promise<CompletionResult | null> {
  const line = context.state.doc.lineAt(context.pos);
  const textBefore = line.text.slice(0, context.pos - line.from);

  const match = textBefore.match(/@([\w./-]*)$/);
  if (!match) return null;

  const glob = getGlob();
  if (!glob) return null;

  const prefix = match[1];
  const atPos = context.pos - match[0].length;

  return fetchFiles(prefix, glob).then((files) => {
    if (files.length === 0) return null;
    return {
      from: atPos,
      options: files.map((f) => ({
        label: `@${f}`,
        apply: `@${f} `,
        type: 'file',
      })),
      filter: false,
    };
  });
}

async function fetchFiles(prefix: string, glob: GlobFn): Promise<string[]> {
  try {
    const pattern = prefix ? `${prefix}*` : '**/*';
    const result = await glob(pattern, { maxResults: 50 });
    return result.matches.filter((file) => file !== '.');
  } catch {
    return [];
  }
}
