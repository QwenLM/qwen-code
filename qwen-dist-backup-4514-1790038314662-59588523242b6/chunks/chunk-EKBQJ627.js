// Force strict mode and setup for ESM
"use strict";
import {
  atomicWriteFileSync
} from "./chunk-CA63HYHU.js";
import {
  Storage,
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/config/installationManager.ts
init_esbuild_shims();
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
var debugLogger = createDebugLogger("INSTALLATION");
var InstallationManager = class {
  static {
    __name(this, "InstallationManager");
  }
  getInstallationIdPath() {
    return Storage.getInstallationIdPath();
  }
  readInstallationIdFromFile() {
    const installationIdFile = this.getInstallationIdPath();
    if (fs.existsSync(installationIdFile)) {
      const installationid = fs.readFileSync(installationIdFile, "utf-8").trim();
      return installationid || null;
    }
    return null;
  }
  writeInstallationIdToFile(installationId) {
    const installationIdFile = this.getInstallationIdPath();
    const dir = path.dirname(installationIdFile);
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(installationIdFile, installationId, {
      encoding: "utf-8"
    });
  }
  /**
   * Retrieves the installation ID from a file, creating it if it doesn't exist.
   * This ID is used for unique user installation tracking.
   * @returns A UUID string for the user.
   */
  getInstallationId() {
    try {
      let installationId = this.readInstallationIdFromFile();
      if (!installationId) {
        installationId = randomUUID();
        this.writeInstallationIdToFile(installationId);
      }
      return installationId;
    } catch (error) {
      debugLogger.error(
        "Error accessing installation ID file, generating ephemeral ID:",
        error
      );
      return "123456789";
    }
  }
};

export {
  InstallationManager
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
