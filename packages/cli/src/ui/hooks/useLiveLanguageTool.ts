import { useEffect, useMemo, useRef, useState } from 'react';

// Tipos para o LanguageTool
type LTMatch = {
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

type LTCheckParams = {
  server?: string;
  text: string;
  language?: string;
  motherTongue?: string;
  enabledRules?: string[];
  disabledRules?: string[];
  level?: 'default' | 'picky';
  signal?: AbortSignal;
};

type LTCheckResponse = {
  matches: LTMatch[];
  language?: { name?: string; code?: string; detected?: boolean };
};

// Funções auxiliares para o LanguageTool
const toCsv = (xs?: string[]) => (xs && xs.length ? xs.join(',') : undefined);

async function checkText({
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
    signal,
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`LanguageTool HTTP ${res.status}: ${msg}`);
  }

  return (await res.json()) as LTCheckResponse;
}

function applySuggestions(
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

// Configurações padrão do LanguageTool
const DEFAULT_LT_OPTIONS = {
  server: 'http://localhost:8081',
  language: 'pt-BR',
  motherTongue: undefined as string | undefined,
  rulesOn: undefined as string[] | undefined,
  rulesOff: undefined as string[] | undefined,
  level: 'default' as 'default' | 'picky',
};

export type LiveLTState = {
  matches: LTMatch[];
  corrected: string;
  busy: boolean;
  error: string;
  changes: number;
};

export function useLiveLanguageTool(text: string, debounceMs: number = 400): LiveLTState {
  const [state, setState] = useState<LiveLTState>({
    matches: [],
    corrected: text,
    busy: false,
    error: '',
    changes: 0,
  });

  const ctrlRef = useRef<AbortController | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Normaliza cfg para memo de deps
  const depsKey = useMemo(() => JSON.stringify({
    s: DEFAULT_LT_OPTIONS.server,
    l: DEFAULT_LT_OPTIONS.language,
    mt: DEFAULT_LT_OPTIONS.motherTongue,
    on: DEFAULT_LT_OPTIONS.rulesOn,
    off: DEFAULT_LT_OPTIONS.rulesOff,
    lv: DEFAULT_LT_OPTIONS.level,
  }), [
    DEFAULT_LT_OPTIONS.server,
    DEFAULT_LT_OPTIONS.language,
    DEFAULT_LT_OPTIONS.motherTongue,
    DEFAULT_LT_OPTIONS.rulesOn,
    DEFAULT_LT_OPTIONS.rulesOff,
    DEFAULT_LT_OPTIONS.level,
  ]);

  useEffect(() => {
    // Limpa debounce anterior
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    
    // Se há request em voo, ABORTA
    if (ctrlRef.current) {
      ctrlRef.current.abort();
      ctrlRef.current = null;
    }

    if (!text.trim()) {
      setState(s => ({ ...s, matches: [], corrected: text, busy: false, error: '', changes: 0 }));
      return;
    }

    timerRef.current = setTimeout(async () => {
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setState(s => ({ ...s, busy: true, error: '' }));

      try {
        const res = await checkText({
          server: DEFAULT_LT_OPTIONS.server ?? 'http://localhost:8081',
          text,
          language: DEFAULT_LT_OPTIONS.language ?? 'pt-BR',
          motherTongue: DEFAULT_LT_OPTIONS.motherTongue,
          enabledRules: DEFAULT_LT_OPTIONS.rulesOn,
          disabledRules: DEFAULT_LT_OPTIONS.rulesOff,
          level: DEFAULT_LT_OPTIONS.level ?? 'default',
          signal: ctrl.signal,
        });

        const { text: corrected, changes } = applySuggestions(text, res.matches || [], 'first');
        // Verifica se o request ainda é válido (não foi abortado)
        if (ctrlRef.current === ctrl) {
          setState({ matches: res.matches || [], corrected, busy: false, error: '', changes });
        }
      } catch (e: any) {
        // Se foi abortado, ignora o erro
        if (e?.name === 'AbortError') return;
        // Atualiza o estado com o erro
        if (ctrlRef.current === ctrl) {
          setState(s => ({ ...s, busy: false, error: String(e.message || e) }));
        }
      } finally {
        // Limpa a referência do controller se ainda for o mesmo
        if (ctrlRef.current === ctrl) {
          ctrlRef.current = null;
        }
      }
    }, debounceMs);

    // Função de limpeza
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (ctrlRef.current) {
        ctrlRef.current.abort();
        ctrlRef.current = null;
      }
    };
  }, [text, debounceMs, depsKey]);

  return state;
}