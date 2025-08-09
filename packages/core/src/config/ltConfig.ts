import { LTPolicy, LTOptions } from '../integrations/languagetool/preprocess.js';

// Helpers
const parseCsv = (v?: string) =>
  v?.split(',').map(s => s.trim()).filter(Boolean) ?? [];

const parseBool = (v?: string, def = true) => {
  if (v == null) return def;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
};

// Regras “silenciadas” por padrão (evita falsos positivos comuns em prompts)
const DEFAULT_RULES_OFF_BASE = ['UPPERCASE_SENTENCE_START'];

// Mescla defaults com o que vier do ambiente, sem duplicar
const MERGED_RULES_OFF = Array.from(
  new Set([...DEFAULT_RULES_OFF_BASE, ...parseCsv(process.env.LT_RULES_OFF)])
);

// Configurações padrão do LanguageTool
export const DEFAULT_LT_OPTIONS: LTOptions = {
  // Habilitado por padrão (fail-open deve ser tratado no chamador)
  enabled: parseBool(process.env.LT_ENABLED, true),

  // confirm = mostra sugestão e pergunta antes de aplicar
  policy: (process.env.LT_POLICY as LTPolicy) || 'confirm',

  server: process.env.LT_SERVER?.trim() || 'https://api.languagetool.org/',

  // >>> auto por padrão (como no seu curl)
  language: process.env.LT_LANG?.trim() || 'auto',

  // Ajuda a guiar a autocorreção quando language=auto (opcional)
  motherTongue: process.env.LT_MOTHER_TONGUE?.trim(),

  // Regras
  rulesOn: parseCsv(process.env.LT_RULES_ON),
  rulesOff: MERGED_RULES_OFF,

  // Nível de checagem
  level: (process.env.LT_LEVEL as 'default' | 'picky') || 'default',
};
