export type RecentDirScenario = 'none' | 'few' | 'many'

const RECENT_DIR_SCENARIO_DATA: Record<RecentDirScenario, string[]> = {
  none: [],
  few: [
    '/Users/demo/projects/craft-agent',
    '/Users/demo/projects/craft-agent/apps/electron',
    '/Users/demo/projects/craft-agent/packages/shared',
  ],
  many: [
    '/Users/demo/projects/craft-agent',
    '/Users/demo/projects/craft-agent/apps/electron',
    '/Users/demo/projects/craft-agent/apps/viewer',
    '/Users/demo/projects/craft-agent/apps/cli',
    '/Users/demo/projects/craft-agent/packages/shared',
    '/Users/demo/projects/craft-agent/packages/server-core',
    '/Users/demo/projects/craft-agent/packages/qwen-code',
    '/Users/demo/projects/craft-agent/packages/ui',
    '/Users/demo/projects/craft-agent/scripts',
  ],
}

/** Return a copy of the fixture list for the selected scenario. */
export function getRecentDirsForScenario(scenario: RecentDirScenario): string[] {
  return [...RECENT_DIR_SCENARIO_DATA[scenario]]
}
