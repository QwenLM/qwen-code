/** Canonical config filename */
export const AUTOMATIONS_CONFIG_FILE = 'automations.json';

/** History log filename */
export const AUTOMATIONS_HISTORY_FILE = 'automations-history.jsonl';

/** Persistent retry queue filename */
export const AUTOMATIONS_RETRY_QUEUE_FILE = 'automations-retry-queue.jsonl';

/** Default HTTP method for webhook actions */
export const DEFAULT_WEBHOOK_METHOD = 'POST';

/** Maximum length for string fields written to automations-history.jsonl (error, responseBody, prompt). */
export const HISTORY_FIELD_MAX_LENGTH = 2000;

/** Max history entries retained per automation ID. */
export const AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER = 20;

/** Max total history entries across all automations (global safety cap). */
export const AUTOMATION_HISTORY_MAX_ENTRIES = 1000;
