// Force strict mode and setup for ESM
"use strict";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/mcp/token-storage/keychain-token-storage.ts
init_esbuild_shims();
import * as crypto from "node:crypto";

// packages/core/src/mcp/token-storage/base-token-storage.ts
init_esbuild_shims();
var BaseTokenStorage = class {
  static {
    __name(this, "BaseTokenStorage");
  }
  serviceName;
  constructor(serviceName) {
    this.serviceName = serviceName;
  }
  validateCredentials(credentials) {
    if (!credentials.serverName) {
      throw new Error("Server name is required");
    }
    if (!credentials.token) {
      throw new Error("Token is required");
    }
    if (!credentials.token.accessToken) {
      throw new Error("Access token is required");
    }
    if (!credentials.token.tokenType) {
      throw new Error("Token type is required");
    }
  }
  isTokenExpired(credentials) {
    if (!credentials.token.expiresAt) {
      return false;
    }
    const bufferMs = 5 * 60 * 1e3;
    return Date.now() + bufferMs >= credentials.token.expiresAt;
  }
  sanitizeServerName(serverName) {
    return serverName.replace(/[^a-zA-Z0-9-_.]/g, "_");
  }
};

// packages/core/src/mcp/token-storage/keychain-token-storage.ts
var debugLogger = createDebugLogger("MCP_KEYCHAIN");
var KEYCHAIN_TEST_PREFIX = "__keychain_test__";
var SECRET_PREFIX = "__secret__";
var KeychainTokenStorage = class extends BaseTokenStorage {
  static {
    __name(this, "KeychainTokenStorage");
  }
  keychainAvailable = null;
  keytarModule = null;
  keytarLoadAttempted = false;
  async getKeytar() {
    if (this.keytarLoadAttempted) {
      return this.keytarModule;
    }
    this.keytarLoadAttempted = true;
    try {
      const moduleName = "keytar";
      const module = await import(moduleName);
      this.keytarModule = module.default || module;
    } catch (error) {
      debugLogger.error(`Failed to load keytar module: ${error}`);
    }
    return this.keytarModule;
  }
  async getCredentials(serverName) {
    if (!await this.checkKeychainAvailability()) {
      throw new Error("Keychain is not available");
    }
    const keytar = await this.getKeytar();
    if (!keytar) {
      throw new Error("Keytar module not available");
    }
    try {
      const sanitizedName = this.sanitizeServerName(serverName);
      const data = await keytar.getPassword(this.serviceName, sanitizedName);
      if (!data) {
        return null;
      }
      const credentials = JSON.parse(data);
      if (this.isTokenExpired(credentials)) {
        return null;
      }
      return credentials;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Failed to parse stored credentials for ${serverName}`);
      }
      throw error;
    }
  }
  async setCredentials(credentials) {
    if (!await this.checkKeychainAvailability()) {
      throw new Error("Keychain is not available");
    }
    const keytar = await this.getKeytar();
    if (!keytar) {
      throw new Error("Keytar module not available");
    }
    this.validateCredentials(credentials);
    const sanitizedName = this.sanitizeServerName(credentials.serverName);
    const updatedCredentials = {
      ...credentials,
      updatedAt: Date.now()
    };
    const data = JSON.stringify(updatedCredentials);
    await keytar.setPassword(this.serviceName, sanitizedName, data);
  }
  async deleteCredentials(serverName) {
    if (!await this.checkKeychainAvailability()) {
      throw new Error("Keychain is not available");
    }
    const keytar = await this.getKeytar();
    if (!keytar) {
      throw new Error("Keytar module not available");
    }
    const sanitizedName = this.sanitizeServerName(serverName);
    const deleted = await keytar.deletePassword(
      this.serviceName,
      sanitizedName
    );
    if (!deleted) {
      throw new Error(`No credentials found for ${serverName}`);
    }
  }
  async listServers() {
    if (!await this.checkKeychainAvailability()) {
      throw new Error("Keychain is not available");
    }
    const keytar = await this.getKeytar();
    if (!keytar) {
      throw new Error("Keytar module not available");
    }
    try {
      const credentials = await keytar.findCredentials(this.serviceName);
      return credentials.filter((cred) => !cred.account.startsWith(KEYCHAIN_TEST_PREFIX)).filter((cred) => !cred.account.startsWith(SECRET_PREFIX)).map((cred) => cred.account);
    } catch (error) {
      debugLogger.error(`Failed to list servers from keychain: ${error}`);
      return [];
    }
  }
  async getAllCredentials() {
    if (!await this.checkKeychainAvailability()) {
      throw new Error("Keychain is not available");
    }
    const keytar = await this.getKeytar();
    if (!keytar) {
      throw new Error("Keytar module not available");
    }
    const result = /* @__PURE__ */ new Map();
    try {
      const credentials = (await keytar.findCredentials(this.serviceName)).filter((c) => !c.account.startsWith(KEYCHAIN_TEST_PREFIX)).filter((c) => !c.account.startsWith(SECRET_PREFIX));
      for (const cred of credentials) {
        try {
          const data = JSON.parse(cred.password);
          if (!this.isTokenExpired(data)) {
            result.set(cred.account, data);
          }
        } catch (error) {
          debugLogger.error(
            `Failed to parse credentials for ${cred.account}: ${error}`
          );
        }
      }
    } catch (error) {
      debugLogger.error(
        `Failed to get all credentials from keychain: ${error}`
      );
    }
    return result;
  }
  async clearAll() {
    if (!await this.checkKeychainAvailability()) {
      throw new Error("Keychain is not available");
    }
    const servers = this.keytarModule ? await this.keytarModule.findCredentials(this.serviceName).then((creds) => creds.map((c) => c.account)).catch((error) => {
      throw new Error(
        `Failed to list servers for clearing: ${error.message}`
      );
    }) : [];
    const errors = [];
    for (const server of servers) {
      try {
        await this.deleteCredentials(server);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `Failed to clear some credentials: ${errors.map((e) => e.message).join(", ")}`
      );
    }
  }
  // Checks whether or not a set-get-delete cycle with the keychain works.
  // Returns false if any operation fails.
  async checkKeychainAvailability() {
    if (this.keychainAvailable !== null) {
      return this.keychainAvailable;
    }
    try {
      const keytar = await this.getKeytar();
      if (!keytar) {
        this.keychainAvailable = false;
        return false;
      }
      const testAccount = `${KEYCHAIN_TEST_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
      const testPassword = "test";
      await keytar.setPassword(this.serviceName, testAccount, testPassword);
      const retrieved = await keytar.getPassword(this.serviceName, testAccount);
      const deleted = await keytar.deletePassword(
        this.serviceName,
        testAccount
      );
      const success = deleted && retrieved === testPassword;
      this.keychainAvailable = success;
      return success;
    } catch (_error) {
      this.keychainAvailable = false;
      return false;
    }
  }
  async isAvailable() {
    return this.checkKeychainAvailability();
  }
  async setSecret(key, value) {
    if (!await this.checkKeychainAvailability()) {
      throw new Error("Keychain is not available");
    }
    const keytar = await this.getKeytar();
    if (!keytar) {
      throw new Error("Keytar module not available");
    }
    await keytar.setPassword(this.serviceName, `${SECRET_PREFIX}${key}`, value);
  }
  async getSecret(key) {
    if (!await this.checkKeychainAvailability()) {
      throw new Error("Keychain is not available");
    }
    const keytar = await this.getKeytar();
    if (!keytar) {
      throw new Error("Keytar module not available");
    }
    return keytar.getPassword(this.serviceName, `${SECRET_PREFIX}${key}`);
  }
  async deleteSecret(key) {
    if (!await this.checkKeychainAvailability()) {
      throw new Error("Keychain is not available");
    }
    const keytar = await this.getKeytar();
    if (!keytar) {
      throw new Error("Keytar module not available");
    }
    const deleted = await keytar.deletePassword(
      this.serviceName,
      `${SECRET_PREFIX}${key}`
    );
    if (!deleted) {
      throw new Error(`No secret found for key: ${key}`);
    }
  }
  async listSecrets() {
    if (!await this.checkKeychainAvailability()) {
      throw new Error("Keychain is not available");
    }
    const keytar = await this.getKeytar();
    if (!keytar) {
      throw new Error("Keytar module not available");
    }
    try {
      const credentials = await keytar.findCredentials(this.serviceName);
      return credentials.filter((cred) => cred.account.startsWith(SECRET_PREFIX)).map((cred) => cred.account.substring(SECRET_PREFIX.length));
    } catch (error) {
      debugLogger.error(`Failed to list secrets from keychain: ${error}`);
      return [];
    }
  }
};

export {
  BaseTokenStorage,
  KeychainTokenStorage
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
