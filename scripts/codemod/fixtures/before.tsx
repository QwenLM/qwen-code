import React from 'react';
import { Box, Text } from 'ink';

export function App() {
  return (
    <Box flexDirection="column" key="root">
      <Box padding={2} gap={1}>
        <Text color="green">hello</Text>
      </Box>
      <Box style={{ overflow: 'hidden' }} flexGrow={1} width="50%">
        <Text>world</Text>
      </Box>
      <Box alignItems="center" justifyContent="center">
        <Text bold>status</Text>
        <Box
          height={3}
          borderStyle="round"
          borderColor="cyan"
          backgroundColor="blue"
          margin={1}
        />
      </Box>
    </Box>
  );
}
