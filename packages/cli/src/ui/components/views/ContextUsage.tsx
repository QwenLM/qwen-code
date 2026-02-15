/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import type {
  ContextCategoryBreakdown,
  ContextToolDetail,
  ContextMemoryDetail,
  ContextSkillDetail,
} from '../../types.js';
import { t } from '../../../i18n/index.js';

// Progress bar characters
const FILLED = '\u2588'; // █ - filled block
const BUFFER = '\u2592'; // ▒ - medium shade (autocompact buffer)
const EMPTY = '\u2591'; // ░ - light shade (free space)

const CONTENT_WIDTH = 56;

interface ContextUsageProps {
  modelName: string;
  totalTokens: number;
  contextWindowSize: number;
  breakdown: ContextCategoryBreakdown;
  builtinTools: ContextToolDetail[];
  mcpTools: ContextToolDetail[];
  memoryFiles: ContextMemoryDetail[];
  skills: ContextSkillDetail[];
  /** True when totalTokens is estimated (no API call yet) */
  isEstimated?: boolean;
}

/**
 * Truncate a string to maxLen, appending '…' if truncated.
 */
function truncateName(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  return name.slice(0, maxLen - 1) + '\u2026';
}

/**
 * Format token count for display (e.g. 1234 -> "1.2k", 123456 -> "123.5k")
 */
function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return `${tokens}`;
}

/**
 * Render a three-segment progress bar: used | autocompact buffer | free space.
 */
const ProgressBar: React.FC<{
  usedPercentage: number;
  bufferPercentage: number;
  width: number;
}> = ({ usedPercentage, bufferPercentage, width }) => {
  const usedCount = Math.round((Math.min(usedPercentage, 100) / 100) * width);
  const bufferCount = Math.round(
    (Math.min(bufferPercentage, 100 - usedPercentage) / 100) * width,
  );
  const freeCount = Math.max(0, width - usedCount - bufferCount);

  const usedStr = FILLED.repeat(Math.max(0, usedCount));
  const freeStr = EMPTY.repeat(Math.max(0, freeCount));
  const bufferStr = BUFFER.repeat(Math.max(0, bufferCount));

  // Used color: accent by default, warning/error at high usage.
  let usedColor = theme.text.accent;
  if (usedPercentage > 80) {
    usedColor = theme.status.error;
  } else if (usedPercentage > 60) {
    usedColor = theme.status.warning;
  }

  return (
    <Text>
      <Text color={usedColor}>{usedStr}</Text>
      <Text color={theme.text.secondary}>{freeStr}</Text>
      <Text color={theme.status.warning}>{bufferStr}</Text>
    </Text>
  );
};

/**
 * A row showing a category with its token count and percentage.
 */
const CategoryRow: React.FC<{
  symbol: string;
  label: string;
  tokens: number;
  contextWindowSize: number;
  symbolColor?: string;
}> = ({ symbol, label, tokens, contextWindowSize, symbolColor }) => {
  const percentage = ((tokens / contextWindowSize) * 100).toFixed(1);
  const tokenStr = `${formatTokens(tokens)} ${t('tokens')} (${percentage}%)`;

  return (
    <Box width={CONTENT_WIDTH}>
      <Box width={2}>
        <Text color={symbolColor || theme.text.secondary}>{symbol}</Text>
      </Box>
      <Box width={24}>
        <Text color={theme.text.primary}>{label}</Text>
      </Box>
      <Box flexGrow={1} justifyContent="flex-end">
        <Text color={theme.text.secondary}>{tokenStr}</Text>
      </Box>
    </Box>
  );
};

/**
 * A detail row for individual items (MCP tools, memory files, skills).
 */
const DETAIL_NAME_MAX_LEN = 30;

const DetailRow: React.FC<{
  name: string;
  tokens: number;
}> = ({ name, tokens }) => {
  const tokenStr =
    tokens > 0 ? `${formatTokens(tokens)} ${t('tokens')}` : `0 ${t('tokens')}`;
  return (
    <Box width={CONTENT_WIDTH} paddingLeft={2}>
      <Text color={theme.text.secondary}>{'\u2514'} </Text>
      <Box width={32}>
        <Text color={theme.text.link}>
          {truncateName(name, DETAIL_NAME_MAX_LEN)}
        </Text>
      </Box>
      <Box flexGrow={1} justifyContent="flex-end">
        <Text color={theme.text.secondary}>{tokenStr}</Text>
      </Box>
    </Box>
  );
};

export const ContextUsage: React.FC<ContextUsageProps> = ({
  modelName,
  totalTokens,
  contextWindowSize,
  breakdown,
  builtinTools,
  mcpTools,
  memoryFiles,
  skills,
  isEstimated,
}) => {
  const percentage =
    contextWindowSize > 0 ? (totalTokens / contextWindowSize) * 100 : 0;

  // Sort detail items by token count (descending) for better readability
  const sortedBuiltinTools = [...builtinTools].sort(
    (a, b) => b.tokens - a.tokens,
  );
  const sortedMcpTools = [...mcpTools].sort((a, b) => b.tokens - a.tokens);
  const sortedMemoryFiles = [...memoryFiles].sort(
    (a, b) => b.tokens - a.tokens,
  );
  const sortedSkills = [...skills].sort((a, b) => b.tokens - a.tokens);

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingY={1}
      paddingX={2}
    >
      {/* Title */}
      <Text bold color={theme.text.accent}>
        {t('Context Usage')}
      </Text>
      <Box height={1} />

      {isEstimated ? (
        <>
          {/* No API data yet — show hint instead of progress bar */}
          <Box marginBottom={1}>
            <Text color={theme.status.warning} italic>
              {t('No API response yet. Send a message to see actual usage.')}
            </Text>
          </Box>

          {/* Estimated overhead categories */}
          <Text bold color={theme.text.primary}>
            {t('Estimated pre-conversation overhead')}
          </Text>
          <Text color={theme.text.secondary}>
            {t('Model')}: {modelName}
            {'  '}
            {t('Context window')}: {formatTokens(contextWindowSize)}{' '}
            {t('tokens')}
          </Text>
          <Box height={1} />
        </>
      ) : (
        <>
          {/* Model name + context window info */}
          <Box width={CONTENT_WIDTH} marginBottom={1}>
            <Text color={theme.text.secondary}>{modelName}</Text>
            <Box flexGrow={1} justifyContent="flex-end">
              <Text color={theme.text.secondary}>
                {t('Context window')}: {formatTokens(contextWindowSize)}{' '}
                {t('tokens')}
              </Text>
            </Box>
          </Box>
          {/* Progress bar — three segments: used | free | buffer */}
          <Box width={CONTENT_WIDTH}>
            <ProgressBar
              usedPercentage={Math.min(percentage, 100)}
              bufferPercentage={
                contextWindowSize > 0
                  ? (breakdown.autocompactBuffer / contextWindowSize) * 100
                  : 0
              }
              width={CONTENT_WIDTH}
            />
          </Box>
          <Box height={1} />
          {/* Legend — same layout as CategoryRow for alignment */}
          <CategoryRow
            symbol={FILLED}
            label={t('Used')}
            tokens={totalTokens}
            contextWindowSize={contextWindowSize}
            symbolColor={theme.text.accent}
          />
          <CategoryRow
            symbol={EMPTY}
            label={t('Free')}
            tokens={breakdown.freeSpace}
            contextWindowSize={contextWindowSize}
            symbolColor={theme.text.secondary}
          />
          <CategoryRow
            symbol={BUFFER}
            label={t('Autocompact')}
            tokens={breakdown.autocompactBuffer}
            contextWindowSize={contextWindowSize}
            symbolColor={theme.status.warning}
          />
          <Box height={1} />

          {/* Breakdown header */}
          <Text bold color={theme.text.primary}>
            {t('Usage by category')}
          </Text>
        </>
      )}

      <CategoryRow
        symbol={FILLED}
        label={t('System prompt')}
        tokens={breakdown.systemPrompt}
        contextWindowSize={contextWindowSize}
        symbolColor={theme.text.accent}
      />
      <CategoryRow
        symbol={FILLED}
        label={t('Built-in tools')}
        tokens={breakdown.builtinTools}
        contextWindowSize={contextWindowSize}
        symbolColor={theme.text.accent}
      />
      {breakdown.mcpTools > 0 && (
        <CategoryRow
          symbol={FILLED}
          label={t('MCP tools')}
          tokens={breakdown.mcpTools}
          contextWindowSize={contextWindowSize}
          symbolColor={theme.text.accent}
        />
      )}
      <CategoryRow
        symbol={FILLED}
        label={t('Memory files')}
        tokens={breakdown.memoryFiles}
        contextWindowSize={contextWindowSize}
        symbolColor={theme.text.accent}
      />
      <CategoryRow
        symbol={FILLED}
        label={t('Skills')}
        tokens={breakdown.skills}
        contextWindowSize={contextWindowSize}
        symbolColor={theme.text.accent}
      />
      {/* Only show Messages when we have real API data */}
      {!isEstimated && (
        <CategoryRow
          symbol={FILLED}
          label={t('Messages')}
          tokens={breakdown.messages}
          contextWindowSize={contextWindowSize}
          symbolColor={theme.text.accent}
        />
      )}

      {/* Built-in tools detail */}
      {sortedBuiltinTools.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.text.primary}>
            {t('Built-in tools')}
          </Text>
          {sortedBuiltinTools.map((tool) => (
            <DetailRow key={tool.name} name={tool.name} tokens={tool.tokens} />
          ))}
        </Box>
      )}

      {/* MCP Tools detail */}
      {sortedMcpTools.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.text.primary}>
            {t('MCP tools')}
          </Text>
          {sortedMcpTools.map((tool) => (
            <DetailRow key={tool.name} name={tool.name} tokens={tool.tokens} />
          ))}
        </Box>
      )}

      {/* Memory files detail */}
      {sortedMemoryFiles.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.text.primary}>
            {t('Memory files')}
          </Text>
          {sortedMemoryFiles.map((file) => (
            <DetailRow key={file.path} name={file.path} tokens={file.tokens} />
          ))}
        </Box>
      )}

      {/* Skills detail */}
      {sortedSkills.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.text.primary}>
            {t('Skills')}
          </Text>
          {sortedSkills.map((skill) => (
            <DetailRow
              key={skill.name}
              name={skill.name}
              tokens={skill.tokens}
            />
          ))}
        </Box>
      )}
    </Box>
  );
};
