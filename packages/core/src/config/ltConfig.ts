import { LTPolicy, LTOptions } from '../integrations/languagetool/preprocess.js';

// Configurações padrão do LanguageTool
export const DEFAULT_LT_OPTIONS: LTOptions = {
  enabled: process.env.LT_ENABLED === '1',
  policy: (process.env.LT_POLICY as LTPolicy) || 'confirm',
  server: process.env.LT_SERVER || 'http://localhost:8081',
  language: process.env.LT_LANG || 'pt-BR',
  motherTongue: process.env.LT_MOTHER_TONGUE,
  rulesOn: process.env.LT_RULES_ON?.split(',').filter(Boolean),
  rulesOff: process.env.LT_RULES_OFF?.split(',').filter(Boolean),
  level: (process.env.LT_LEVEL as 'default' | 'picky') || 'default',
};
