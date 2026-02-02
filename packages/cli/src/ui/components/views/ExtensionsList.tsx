/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { useUIState } from '../../contexts/UIStateContext.js';
import { ExtensionUpdateState } from '../../state/extensions.js';

export const ExtensionsList = () => {
  const { extensionsUpdateState, commandContext } = useUIState();
  const extensions = commandContext.services.config?.getExtensions() || [];

  if (extensions.length === 0) {
    return <Text>No extensions installed.</Text>;
  }

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text>Installed extensions:</Text>
      <Box flexDirection="column" paddingLeft={2}>
        {extensions.map((ext) => {
          const state = extensionsUpdateState.get(ext.name);
          const isActive = ext.isActive;
          const activeString = isActive ? 'active' : 'disabled';
          const activeColor = isActive ? 'green' : 'grey';

          let stateColor = 'gray';
          const stateText = state || 'unknown state';

          switch (state) {
            case ExtensionUpdateState.CHECKING_FOR_UPDATES:
            case ExtensionUpdateState.UPDATING:
              stateColor = 'cyan';
              break;
            case ExtensionUpdateState.UPDATE_AVAILABLE:
            case ExtensionUpdateState.UPDATED_NEEDS_RESTART:
              stateColor = 'yellow';
              break;
            case ExtensionUpdateState.ERROR:
              stateColor = 'red';
              break;
            case ExtensionUpdateState.UP_TO_DATE:
            case ExtensionUpdateState.NOT_UPDATABLE:
            case ExtensionUpdateState.UPDATED:
              stateColor = 'green';
              break;
            default:
              console.error(`Unhandled ExtensionUpdateState ${state}`);
              break;
          }

          return (
            <Box key={ext.name} flexDirection="column" marginBottom={1}>
              <Text>
                <Text color="cyan">{`${ext.name} (v${ext.version})`}</Text>
                <Text color={activeColor}>{` - ${activeString}`}</Text>
                {<Text color={stateColor}>{` (${stateText})`}</Text>}
              </Text>
              {ext.resolvedSettings && ext.resolvedSettings.length > 0 && (
                <Box flexDirection="column" paddingLeft={2}>
                  <Text>settings:</Text>
                  {ext.resolvedSettings.map((setting) => (
                    <Text key={setting.name}>
                      - {setting.name}: {setting.value}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
