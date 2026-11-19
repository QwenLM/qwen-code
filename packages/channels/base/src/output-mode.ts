import type {
  ChannelConfigEnumFieldDescriptor,
  ChannelOutputMode,
} from './types.js';

export const DEFAULT_CHANNEL_OUTPUT_MODE = 'per_turn';

export const CHANNEL_OUTPUT_MODE_FIELD: ChannelConfigEnumFieldDescriptor = {
  key: 'outputMode',
  label: 'Output Mode',
  kind: 'enum',
  default: DEFAULT_CHANNEL_OUTPUT_MODE,
  description:
    'Choose one final result for the complete task, each complete assistant response, or the last reply in each turn. Defaults to per turn: the main response finishes independently of background follow-ups. Applies to cards and ordinary messages.',
  options: [
    { value: 'per_task', label: 'Per task' },
    { value: 'per_response', label: 'Per response' },
    { value: 'per_turn', label: 'Per turn (default)' },
  ],
};

export function parseChannelOutputMode(
  name: string,
  value: unknown,
  supportsOutputMode: boolean,
): ChannelOutputMode | undefined {
  if (value === undefined) {
    return supportsOutputMode ? DEFAULT_CHANNEL_OUTPUT_MODE : undefined;
  }
  if (!supportsOutputMode) {
    throw new Error(`Channel "${name}" does not support outputMode.`);
  }
  if (
    value !== 'per_task' &&
    value !== 'per_response' &&
    value !== 'per_turn'
  ) {
    throw new Error(
      `Channel "${name}" outputMode must be "per_task", "per_response", or "per_turn".`,
    );
  }
  return value;
}
