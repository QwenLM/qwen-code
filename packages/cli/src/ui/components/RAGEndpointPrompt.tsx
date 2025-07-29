/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Colors } from '../colors.js';

interface RAGEndpointPromptProps {
  onSubmit: (endpoint: string) => void;
  onCancel: () => void;
  onSkip: () => void;
}

export function RAGEndpointPrompt({
  onSubmit,
  onCancel,
  onSkip,
}: RAGEndpointPromptProps): React.JSX.Element {
  const [endpoint, setEndpoint] = useState('');

  useInput((input, key) => {
    // 过滤粘贴相关的控制序列
    let cleanInput = (input || '')
      // 过滤 ESC 开头的控制序列（如 \u001b[200~、\u001b[201~ 等）
      .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '') // eslint-disable-line no-control-regex
      // 过滤粘贴开始标记 [200~
      .replace(/\[200~/g, '')
      // 过滤粘贴结束标记 [201~
      .replace(/\[201~/g, '')
      // 过滤单独的 [ 和 ~ 字符（可能是粘贴标记的残留）
      .replace(/^\[|~$/g, '');

    // 再过滤所有不可见字符（ASCII < 32，除了回车换行）
    cleanInput = cleanInput
      .split('')
      .filter((ch) => ch.charCodeAt(0) >= 32)
      .join('');

    if (cleanInput.length > 0) {
      setEndpoint((prev) => prev + cleanInput);
      return;
    }

    // 检查是否是 Enter 键（通过检查输入是否包含换行符）
    if (input.includes('\n') || input.includes('\r')) {
      if (endpoint.trim()) {
        onSubmit(endpoint.trim());
      }
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }

    // Handle 's' key for skip
    if (input === 's' || input === 'S') {
      onSkip();
      return;
    }

    // Handle backspace - check both key.backspace and delete key
    if (key.backspace || key.delete) {
      setEndpoint((prev) => prev.slice(0, -1));
      return;
    }
  });

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.AccentBlue}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold color={Colors.AccentBlue}>
        RAG Endpoint Configuration
      </Text>
      <Box marginTop={1}>
        <Text>
          Please enter your RAG endpoint URL to enable knowledge base search functionality.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          You can get your RAG endpoint from your backend dashboard.
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="row">
        <Box width={12}>
          <Text color={Colors.AccentBlue}>
            Endpoint:
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text>
            &gt; {endpoint}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          Press Enter to continue, S to skip, Esc to cancel
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={Colors.AccentPurple}>
          Note: You can configure this later via --rag-endpoint or settings.json
        </Text>
      </Box>
    </Box>
  );
}