/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { RenderInline } from '../../utils/InlineMarkdownRenderer.js';
import { stripUnsafeCharacters } from '../../utils/textUtils.js';
import type { HistoryItemInlineLink } from '../../types.js';
import { PrefixedMessage } from './PrefixedMessage.js';
import { INDENT } from '../../constants/messageLayout.js';
import { FEED_MARKER } from '../../constants/feedGrammar.js';
import { CliSpinner } from '../CliSpinner.js';

interface InfoMessageProps {
  text: string;
  links?: HistoryItemInlineLink[];
  secondaryText?: string;
  source?: string;
  icon?: string;
  color?: string;
  activity?: boolean;
}

const CANCELLATION_NOTICE_TEXTS = new Set([
  'Request cancelled.',
  'User cancelled.',
  'Operation cancelled.',
]);

interface InfoPresentation {
  prefix: string;
  prefixColor: string;
  textColor: string;
  bold: boolean;
}

function getInfoPresentation(
  text: string,
  icon: string | undefined,
  color: string | undefined,
): InfoPresentation {
  if (icon || color) {
    const explicitColor = color ?? theme.text.secondary;
    return {
      prefix: icon ?? '· ',
      prefixColor: explicitColor,
      textColor: explicitColor,
      bold: false,
    };
  }

  if (CANCELLATION_NOTICE_TEXTS.has(text.trim())) {
    return {
      prefix: FEED_MARKER.toolCanceled,
      prefixColor: theme.text.secondary,
      textColor: theme.text.secondary,
      bold: false,
    };
  }

  return {
    prefix: FEED_MARKER.info,
    prefixColor: theme.status.warning,
    textColor: theme.status.warning,
    bold: false,
  };
}

function renderLinkedInline(
  line: string,
  links: HistoryItemInlineLink[] | undefined,
  defaultColor: string,
): React.ReactNode {
  const validLinks =
    links?.filter((link) => link.text.length > 0 && link.href.length > 0) ?? [];
  if (validLinks.length === 0) {
    return (
      <RenderInline
        text={line}
        defaultColor={defaultColor}
        codespanColor={defaultColor}
      />
    );
  }

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  const pushText = (text: string) => {
    if (!text) {
      return;
    }

    const leading = text.match(/^\s+/)?.[0] ?? '';
    const trailing =
      text.length > leading.length ? (text.match(/\s+$/)?.[0] ?? '') : '';
    const body = text.slice(leading.length, text.length - trailing.length);

    if (leading) {
      parts.push(
        <Text key={`space-${key++}`} color={defaultColor}>
          {leading}
        </Text>,
      );
    }
    if (body) {
      parts.push(
        <RenderInline
          key={`text-${key++}`}
          text={body}
          defaultColor={defaultColor}
          codespanColor={defaultColor}
        />,
      );
    }
    if (trailing) {
      parts.push(
        <Text key={`space-${key++}`} color={defaultColor}>
          {trailing}
        </Text>,
      );
    }
  };

  while (cursor < line.length) {
    let next:
      | {
          start: number;
          link: HistoryItemInlineLink;
        }
      | undefined;

    for (const link of validLinks) {
      const start = line.indexOf(link.text, cursor);
      if (start === -1) {
        continue;
      }
      if (!next || start < next.start) {
        next = { start, link };
      }
    }

    if (!next) {
      pushText(line.slice(cursor));
      break;
    }

    if (next.start > cursor) {
      pushText(line.slice(cursor, next.start));
    }

    parts.push(
      <React.Fragment key={`link-${key++}`}>
        <ink-link href={next.link.href}>
          <Text color={theme.text.link} underline>
            {stripUnsafeCharacters(next.link.text)}
          </Text>
        </ink-link>
      </React.Fragment>,
    );
    cursor = next.start + next.link.text.length;
  }

  return parts;
}

export const InfoMessage: React.FC<InfoMessageProps> = ({
  text,
  links,
  secondaryText,
  source,
  icon,
  color,
  activity = false,
}) => {
  const presentation = getInfoPresentation(text, icon, color);
  const prefixWidth = Math.max(
    presentation.prefix.length,
    INDENT.PREFIX_WIDTH_STANDARD,
  );
  const lines = text.split('\n');

  return (
    <PrefixedMessage
      prefix={
        activity ? (
          <Text color={presentation.prefixColor}>
            <CliSpinner type="star" />{' '}
          </Text>
        ) : (
          <Text color={presentation.prefixColor} bold={presentation.bold}>
            {presentation.prefix}
          </Text>
        )
      }
      prefixWidth={prefixWidth}
    >
      {lines.map((line, index) => (
        <Text wrap="wrap" key={index} bold={presentation.bold}>
          {renderLinkedInline(line, links, presentation.textColor)}
          {index === lines.length - 1 && secondaryText && (
            <Text color={theme.text.response}> {secondaryText}</Text>
          )}
          {index === lines.length - 1 && source && (
            <Text color={theme.ui.comment}> [{source}]</Text>
          )}
        </Text>
      ))}
    </PrefixedMessage>
  );
};
