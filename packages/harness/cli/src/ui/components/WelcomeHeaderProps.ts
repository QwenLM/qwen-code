export interface CliWelcomeHeaderProps {
  /** Display name for the welcome header. */
  cliDisplayName: string;
  /** Terminal columns available to the header. */
  terminalWidth: number;
  /** Running version, e.g. "1.1.58". */
  version: string;
  /** Running version label, e.g. "v1.1.58". */
  versionLabel: string;
  /** Host-owned tips; call `markShown` once the tips are actually on screen. */
  tips?: { title: string; lines: readonly string[]; markShown(): void };
}
