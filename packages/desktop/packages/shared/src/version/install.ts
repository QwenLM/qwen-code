import { mkdir, chmod, symlink, unlink, lstat, access } from "fs/promises";
import { PassThrough, pipeline } from "stream";
import { promisify } from "util";
import { getLatestVersion, getManifest } from "./manifest";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import * as tar from "tar";
import { debug } from "../utils/debug";
import { getUpdateToVersion, getCurrentVersion } from "./version";

const pipelineAsync = promisify(pipeline);

export async function downloadArchive(params: { url: string, sha256: string }): Promise<ArrayBuffer | null> {
  const { url, sha256 } = params;
  const response = await fetch(url);
  debug(`[install] Fetching archive from: ${url}`);
  const data = await response.arrayBuffer();
  const buffer = Buffer.from(data);
  const hash = createHash('sha256').update(buffer).digest('hex');
  if (hash !== sha256) {
    debug(`[install] Checksum mismatch: ${hash} !== ${sha256}`);
    return null;
  }
  return data;
}

export async function ensureDirectory(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    await mkdir(path, { recursive: true });
  }
}

async function extractArchive(params: { archiveData: ArrayBuffer, destination: string }): Promise<void> {
  const { archiveData, destination } = params;
  const buffer = Buffer.from(archiveData);
  const stream = new PassThrough();
  stream.end(buffer);
  
  await pipelineAsync(
    stream,
    tar.x({ C: destination, gzip: true })
  );
}

export async function installArchive(params: { archiveData: ArrayBuffer, version: string }): Promise<void> {
  const { archiveData, version } = params;
  const versionDirectory = join(homedir(), '.local', 'share', 'craft', 'versions', version);
  const binaryPath = join(versionDirectory, 'craft');
  const symlinkDirectory = join(homedir(), '.local', 'bin');
  const symlinkPath = join(symlinkDirectory, 'craft');

  await ensureDirectory(versionDirectory);
  await ensureDirectory(symlinkDirectory);

  await extractArchive({ archiveData, destination: versionDirectory });
  await chmod(binaryPath, '755');
  // Use lstat to check if symlink exists (even if broken/pointing to nothing)
  try {
    await lstat(symlinkPath);
    await unlink(symlinkPath);
  } catch {
    // Symlink doesn't exist, that's fine
  }
  await symlink(binaryPath, symlinkPath);
}

export async function install(version: string | null): Promise<VersionInstallResult> {
  if (version === 'latest' || version == null) {
    version = await getLatestVersion();
  }
  if (version == null) {
    debug('[install] Failed to get the latest version');
    return { success: false, error: 'Failed to get the latest version' };
  }
  debug(`[install] Installing version: ${version}`);

  const manifest = await getManifest(version);
  if (manifest == null) {
    debug('[install] Failed to get the manifest');
    return { success: false, error: 'Failed to get the manifest' };
  }

  const platform = `${process.platform}-${process.arch}`;
  const binary = manifest.binaries[platform];
  if (binary == null) {
    debug(`[install] No binary found for platform: ${platform}`);
    return { success: false, error: `No binary found for platform: ${platform}` };
  }
  const binaryUrl = binary.url;
  const binarySha256 = binary.sha256;
  debug(`[install] Binary URL: ${binaryUrl}`);
  debug(`[install] Binary SHA256: ${binarySha256}`);
  debug(`[install] Binary size: ${binary.size}`);

  const archiveData = await downloadArchive({ url: binaryUrl, sha256: binarySha256 });
  if (archiveData == null) {
    debug('[install] Failed to download binary');
    return { success: false, error: 'Failed to download binary' };
  }
  await installArchive({ archiveData, version });

  return { success: true };
}

type VersionInstallResult = {
  success: true;
} | {
  success: false;
  error: string;
};

/**
 * Check for updates and install in the background if available.
 * This runs silently - no user confirmation needed.
 * Logs are only visible with --debug flag.
 * Skips when running locally (version 0.0.1).
 */
export async function checkAndUpdate(): Promise<void> {
  try {
    const currentVersion = getCurrentVersion();
    
    // Skip auto-update when running locally (dev mode uses 0.0.1)
    if (currentVersion === '0.0.1') {
      debug('[auto-update] Skipping - running locally (version 0.0.1)');
      return;
    }
    
    debug('[auto-update] Checking for updates...');
    const updateVersion = await getUpdateToVersion();
    
    if (!updateVersion) {
      debug('[auto-update] Already up to date');
      return;
    }
    
    debug(`[auto-update] Update available: ${currentVersion} -> ${updateVersion}`);
    debug('[auto-update] Starting background update...');
    
    const result = await install(updateVersion);
    
    if (result.success) {
      debug(`[auto-update] Successfully updated to ${updateVersion}. Restart to use new version.`);
    } else {
      debug(`[auto-update] Update failed: ${result.error}`);
    }
  } catch (error) {
    debug(`[auto-update] Error during update check: ${error instanceof Error ? error.message : String(error)}`);
  }
}