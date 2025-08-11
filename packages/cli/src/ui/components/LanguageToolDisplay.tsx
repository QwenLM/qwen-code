import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';

// Tipo para o LanguageTool
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

type AnnotatedTextProps = {
  text: string;
  matches: LTMatch[];
};

/**
 * Componente que renderiza o texto com trechos problemáticos sublinhados em vermelho
 */
export const AnnotatedText: React.FC<AnnotatedTextProps> = ({ text, matches }) => {
  // Cria spans sublinhados para os trechos com problema
  const annotatedParts = useMemo(() => {
    // Ordena os matches por offset
    const sorted = [...(matches || [])].sort((a, b) => a.offset - b.offset);
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    let key = 0;

    for (const match of sorted) {
      const { offset, length } = match;
      // Ignora sobreposições
      if (offset < cursor) continue;
      
      // Adiciona o texto antes do match
      if (offset > cursor) {
        parts.push(<Text key={`p${key++}`}>{text.slice(cursor, offset)}</Text>);
      }
      
      // Adiciona o trecho problemático sublinhado em vermelho
      const hit = text.slice(offset, offset + length);
      parts.push(<Text key={`h${key++}`} underline color="red">{hit}</Text>);
      
      cursor = offset + length;
    }
    
    // Adiciona o restante do texto
    if (cursor < text.length) {
      parts.push(<Text key={`p${key++}`}>{text.slice(cursor)}</Text>);
    }
    
    return parts;
  }, [text, matches]);

  return <>{annotatedParts}</>;
};

type LanguageToolIndicatorProps = {
  matches: LTMatch[];
  busy: boolean;
  error: string;
  changes: number;
};

/**
 * Componente que exibe indicadores do LanguageTool (erros, sugestões, etc.)
 */
export const LanguageToolIndicator: React.FC<LanguageToolIndicatorProps> = ({
  matches,
  busy,
  error,
  changes,
}) => {
  if (error) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="red">Erro no LanguageTool: {error}</Text>
      </Box>
    );
  }

  if (busy) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">Verificando gramática...</Text>
      </Box>
    );
  }

  if (matches.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="green">Nenhum erro encontrado.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        {matches.length} problema(s) encontrado(s)
        {changes > 0 ? ` • ${changes} mudança(s) sugerida(s)` : ''}
      </Text>
      <Box marginLeft={2} flexDirection="column">
        {matches.map((match, i) => (
          <Text key={i} dimColor>
            • {match.message}
            {match.replacements?.length ? (
              <Text> → {match.replacements.slice(0, 3).map(r => r.value).join(' | ')}</Text>
            ) : null}
            {match.rule?.id ? <Text>  [{match.rule.id}]</Text> : null}
          </Text>
        ))}
      </Box>
    </Box>
  );
};