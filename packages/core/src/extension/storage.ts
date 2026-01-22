import { Storage } from '../config/storage.js';
import path from 'node:path';
import * as os from 'node:os';
import {
  EXTENSION_SETTINGS_FILENAME,
  EXTENSIONS_CONFIG_FILENAME,
} from './variables.js';
import * as fs from 'node:fs';

export class ExtensionStorage {
  private readonly extensionName: string;

  constructor(extensionName: string) {
    this.extensionName = extensionName;
  }

  getExtensionDir(): string {
    return path.join(
      ExtensionStorage.getUserExtensionsDir(),
      this.extensionName,
    );
  }

  getConfigPath(): string {
    return path.join(this.getExtensionDir(), EXTENSIONS_CONFIG_FILENAME);
  }

  getEnvFilePath(): string {
    return path.join(this.getExtensionDir(), EXTENSION_SETTINGS_FILENAME);
  }

  static getUserExtensionsDir(): string {
    const homeDir = os.homedir();
    // Fallback for test environments where os.homedir might be mocked to return undefined
    if (!homeDir) {
      const tmpDir = os.tmpdir();
      if (!tmpDir) {
        // Ultimate fallback when both os.homedir and os.tmpdir are mocked
        return '/tmp/.qwen/extensions';
      }
      return path.join(tmpDir, '.qwen', 'extensions');
    }
    const storage = new Storage(homeDir);
    return storage.getExtensionsDir();
  }

  static async createTmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qwen-extension'));
  }
}
