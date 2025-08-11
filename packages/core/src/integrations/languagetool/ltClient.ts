// Node >= 20 (fetch nativo)
export type LTMatch = {
  message: string;
  shortMessage?: string;
  offset: number;
  length: number;
  replacements?: { value: string }[];
  rule?: {
    id?: string;
    ruleId?: string;
    description?: string;
    issueType?: string;
  };
  context?: { text: string; offset: number; length: number };
};

export type LTCheckParams = {
  server?: string; // default: http://localhost:8081
  text: string;
  language?: string; // ex: 'pt-BR', 'en-US'
  motherTongue?: string; // ex: 'pt-BR'
  enabledRules?: string[]; // ids
  disabledRules?: string[]; // ids
  level?: 'default' | 'picky';
  signal?: AbortSignal; // para cancelamento de requests
};

export type LTCheckResponse = {
  matches: LTMatch[];
  language?: { name?: string; code?: string; detected?: boolean };
};

const toCsv = (xs?: string[]) => (xs && xs.length ? xs.join(',') : undefined);

export async function checkText({
  server = 'http://localhost:8081',
  text,
  language = 'pt-BR',
  motherTongue,
  enabledRules,
  disabledRules,
  level = 'default',
  signal,
}: LTCheckParams): Promise<LTCheckResponse> {
  const body = new URLSearchParams();
  body.set('text', text);
  body.set('language', language);
  if (motherTongue) body.set('motherTongue', motherTongue);
  if (enabledRules?.length) body.set('enabledRules', toCsv(enabledRules)!);
  if (disabledRules?.length) body.set('disabledRules', toCsv(disabledRules)!);
  if (level) body.set('level', level);

  const res = await fetch(`${server.replace(/\/+$/, '')}/v2/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal, // <- importante para cancelamento
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`LanguageTool HTTP ${res.status}: ${msg}`);
  }

  return (await res.json()) as LTCheckResponse;
}

/** Aplica substituições sem quebrar offsets (varre da esquerda p/ direita). */
export function applySuggestions(
  original: string,
  matches: LTMatch[],
  strategy: 'first' | 'best' = 'first',
): { text: string; changes: number } {
  // ordenar por offset crescente
  const sorted = [...matches].sort((a, b) => a.offset - b.offset);

  let out = '';
  let cursor = 0;
  let changes = 0;

  for (const m of sorted) {
    const { offset, length, replacements = [] } = m;
    // pular inconsistências
    if (offset < cursor || offset > original.length) continue;

    const before = original.slice(cursor, offset);
    const current = original.slice(offset, offset + length);

    let repl = '';
    if (replacements.length) {
      if (strategy === 'best') {
        // LanguageTool não manda "confidence" padrão; pega 1ª mesmo.
        repl = replacements[0].value;
      } else {
        repl = replacements[0].value;
      }
    } else {
      // Sem sugestão -> mantém texto original
      repl = current;
    }

    out += before + repl;
    cursor = offset + length;
    if (repl !== current) changes++;
  }

  out += original.slice(cursor);
  return { text: out, changes };
}
