import type { CommandInfo } from '../adapters/types';

export type CommandDisplayCategory = 'custom' | 'skill' | 'system';
export type CommandDisplayCategoryOrder = readonly CommandDisplayCategory[];

export const DEFAULT_COMMAND_CATEGORY_ORDER: CommandDisplayCategoryOrder = [
  'custom',
  'skill',
  'system',
];

export function getCommandDisplayCategory(
  command: CommandInfo,
): CommandDisplayCategory {
  if (command.displayCategory) return command.displayCategory;
  if (command.source === 'builtin-command') return 'system';
  if (command.source === 'bundled-skill' || command.source === 'skill') {
    return 'skill';
  }
  return 'custom';
}

export function compareCommandsByCategory(
  a: CommandInfo,
  b: CommandInfo,
  order: CommandDisplayCategoryOrder = DEFAULT_COMMAND_CATEGORY_ORDER,
): number {
  return (
    getCategoryRank(getCommandDisplayCategory(a), order) -
    getCategoryRank(getCommandDisplayCategory(b), order)
  );
}

export function getCategoryRank(
  category: CommandDisplayCategory,
  order: CommandDisplayCategoryOrder = DEFAULT_COMMAND_CATEGORY_ORDER,
): number {
  const rank = order.indexOf(category);
  return rank >= 0
    ? rank
    : order.length + DEFAULT_COMMAND_CATEGORY_ORDER.indexOf(category);
}
