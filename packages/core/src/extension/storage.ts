import { Storage } from '../config/storage.js';
import path from 'node:path';
import * as os from 'node:os';
import {
  EXTENSION_SETTINGS_FILENAME,
  EXTENSIONS_CONFIG_FILENAME,
} from './variables.js';
import { ExtensionScope } from './types.js';
import * as fs from 'node:fs';

export class ExtensionStorage {
  private readonly extensionName: string;
  private readonly scope: ExtensionScope;
  private readonly workspaceDir?: string;

  /**
   * @param extensionName The directory name the extension is stored under.
   * @param scope Whether the extension lives at user or project scope.
   * @param workspaceDir The project root, required when scope is `Project`.
   */
  constructor(
    extensionName: string,
    scope: ExtensionScope = ExtensionScope.User,
    workspaceDir?: string,
  ) {
    this.extensionName = extensionName;
    this.scope = scope;
    this.workspaceDir = workspaceDir;
  }

  getExtensionDir(): string {
    return path.join(this.getExtensionsBaseDir(), this.extensionName);
  }

  getConfigPath(): string {
    return path.join(this.getExtensionDir(), EXTENSIONS_CONFIG_FILENAME);
  }

  getEnvFilePath(): string {
    return path.join(this.getExtensionDir(), EXTENSION_SETTINGS_FILENAME);
  }

  /**
   * Resolves the extensions directory for this storage's scope:
   * `~/.qwen/extensions/` for user scope, `<project>/.qwen/extensions/` for
   * project scope.
   */
  private getExtensionsBaseDir(): string {
    if (this.scope === ExtensionScope.Project) {
      if (!this.workspaceDir) {
        throw new Error(
          'A workspace directory is required for project-scoped extension storage.',
        );
      }
      return new Storage(this.workspaceDir).getExtensionsDir();
    }
    return ExtensionStorage.getUserExtensionsDir();
  }

  static getUserExtensionsDir(): string {
    return Storage.getUserExtensionsDir();
  }

  static async createTmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qwen-extension'));
  }
}
