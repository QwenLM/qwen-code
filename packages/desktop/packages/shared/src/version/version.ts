import { getLatestVersion } from "./manifest";

declare const CRAFT_AGENT_CLI_VERSION: string | undefined;

export function getCurrentVersion(): string {
  if (typeof CRAFT_AGENT_CLI_VERSION !== 'undefined' && CRAFT_AGENT_CLI_VERSION != null) {
    return CRAFT_AGENT_CLI_VERSION;
  }
  return "0.0.1";
}

export async function isUpToDate(): Promise<boolean> {
  const currentVersion = getCurrentVersion();
  const latestVersion = await getLatestVersion();
  if (latestVersion == null) {
    return true; // When latest version is not available, we assume the app is up to date to avoid updating to an unknown version
  }
  return currentVersion === latestVersion;
}

/**
 * Returns the latest version or null if the app is up to date
 */
export async function getUpdateToVersion(): Promise<string | null> {
  if (await isUpToDate()) {
    return null;
  }
  const version = await getLatestVersion();
  if (version == null) {
    return null;
  }
  return version;
}
