import React from 'react';
import { Box, Text } from 'ink';

export function App() {
  return (
    <box style={{ flexDirection: 'column' }} key="root">
      <box style={{ padding: 2, gap: 1 }}>
        <text color="green">hello</text>
      </box>
      <box style={{ overflow: 'hidden', flexGrow: 1, width: '50%' }}>
        <text>world</text>
      </box>
      <box style={{ alignItems: 'center', justifyContent: 'center' }}>
        <text bold>status</text>
        <box
          style={{
            height: 3,
            borderStyle: 'round',
            borderColor: 'cyan',
            backgroundColor: 'blue',
            margin: 1,
          }}
        />
      </box>
    </box>
  );
}
