import type {
  ChannelConfigEnumFieldDescriptor,
  ChannelOutputMode,
} from './types.js';

export const CHANNEL_OUTPUT_MODE_FIELD: ChannelConfigEnumFieldDescriptor = {
  key: 'outputMode',
  label: 'Output Mode',
  kind: 'enum',
  description:
    'Select assistant output within each turn. Background follow-ups finish independently of the main response. Omit outputMode in settings.json to retain existing delivery.',
  options: [
    { value: 'final_only', label: 'Final result only' },
    { value: 'process_and_result', label: 'Process and results' },
  ],
};

export function parseChannelOutputMode(
  name: string,
  value: unknown,
  supportsOutputMode: boolean,
): ChannelOutputMode | undefined {
  if (value === undefined) return undefined;
  if (!supportsOutputMode) {
    throw new Error(`Channel "${name}" does not support outputMode.`);
  }
  if (value !== 'final_only' && value !== 'process_and_result') {
    throw new Error(
      `Channel "${name}" outputMode must be "final_only" or "process_and_result".`,
    );
  }
  return value;
}
