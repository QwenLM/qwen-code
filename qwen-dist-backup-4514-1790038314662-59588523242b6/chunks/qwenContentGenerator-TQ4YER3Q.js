// Force strict mode and setup for ESM
"use strict";
import "./chunk-MRTRBONQ.js";
import "./chunk-GOFAQQZA.js";
import "./chunk-65I7S4Z3.js";
import "./chunk-HEOH7JZY.js";
import "./chunk-TWPJO254.js";
import "./chunk-CQ35AJ4Z.js";
import "./chunk-4YS7RMCB.js";
import "./chunk-PQQV3OBW.js";
import "./chunk-ANKISCKU.js";
import "./chunk-4SZ2636R.js";
import "./chunk-5EZRLTLQ.js";
import "./chunk-QHWCP53L.js";
import "./chunk-C4FISGDN.js";
import "./chunk-O6GEWCJA.js";
import "./chunk-KS6F6LZQ.js";
import "./chunk-6PVPNMXU.js";
import "./chunk-OB57Y2WH.js";
import "./chunk-IMV5DBIP.js";
import "./chunk-IWMYX5LB.js";
import "./chunk-QJNDUTOL.js";
import "./chunk-QPTE6BKL.js";
import "./chunk-U6H3XTFA.js";
import "./chunk-ACHCT36C.js";
import "./chunk-CHEIIBT3.js";
import "./chunk-GHG4PQY2.js";
import "./chunk-YVYK3JYU.js";
import "./chunk-Q5N5NEVT.js";
import "./chunk-ADN5KESB.js";
import "./chunk-SK3RZOPS.js";
import "./chunk-EVZT24AF.js";
import "./chunk-ELRMZTPF.js";
import "./chunk-B5WYAQ4I.js";
import "./chunk-JX6XHPTX.js";
import "./chunk-6C3D7BKK.js";
import "./chunk-ZAQM5T2X.js";
import "./chunk-MNU36NGH.js";
import "./chunk-B3HGO6BB.js";
import "./chunk-AUFTA63J.js";
import "./chunk-SATGWSS6.js";
import "./chunk-MLXTMF7H.js";
import "./chunk-BQMSZSG6.js";
import {
  OpenAIContentGenerator
} from "./chunk-5UE6ZUID.js";
import "./chunk-ACDUHDYG.js";
import "./chunk-2FQM443D.js";
import "./chunk-CF5KXZZX.js";
import "./chunk-VNOVK4I7.js";
import "./chunk-736AZVPL.js";
import "./chunk-WFNEY5G7.js";
import "./chunk-5FHOPPLZ.js";
import "./chunk-S6LOFUVP.js";
import "./chunk-BKVPLSEI.js";
import {
  DashScopeOpenAICompatibleProvider
} from "./chunk-WNM6BA7E.js";
import "./chunk-S7UQ3V2H.js";
import "./chunk-QE36VXWP.js";
import "./chunk-2A6RZKP2.js";
import "./chunk-WDVSRQIQ.js";
import "./chunk-GXNXX7A2.js";
import "./chunk-IITTKFWM.js";
import "./chunk-Z72PLR74.js";
import "./chunk-AYEJOTIU.js";
import "./chunk-BA6AXQDA.js";
import "./chunk-NUQ4GK5I.js";
import "./chunk-KP2FHIFR.js";
import {
  DEFAULT_DASHSCOPE_BASE_URL
} from "./chunk-TLS6QN2S.js";
import {
  SharedTokenManager
} from "./chunk-6DB6UHY3.js";
import "./chunk-NAVJD2PQ.js";
import "./chunk-KKPIFWTZ.js";
import "./chunk-NFC4WTY2.js";
import "./chunk-YSD6IY6F.js";
import "./chunk-DJ2GSRLV.js";
import "./chunk-MS4SXNJ6.js";
import "./chunk-GVTAFLWB.js";
import "./chunk-KKGSJZWK.js";
import "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import "./chunk-25FMWESU.js";
import "./chunk-CFMZLE3L.js";
import "./chunk-43QUA4MC.js";
import "./chunk-WZAD4ZNJ.js";
import "./chunk-EKBQJ627.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-HHJLM3WQ.js";
import "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import "./chunk-ZRQGTRHA.js";
import "./chunk-VPGRGNNH.js";
import "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import "./chunk-UKMWZ5NS.js";
import "./chunk-75DOP5OR.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import "./chunk-EFT7OMDN.js";
import "./chunk-MATEIJZF.js";
import "./chunk-J5TTWBZK.js";
import "./chunk-RVIGZBIT.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/qwen/qwenContentGenerator.ts
init_esbuild_shims();
var QwenContentGenerator = class extends OpenAIContentGenerator {
  static {
    __name(this, "QwenContentGenerator");
  }
  debugLogger = createDebugLogger("QWEN");
  qwenClient;
  sharedManager;
  currentToken;
  constructor(qwenClient, contentGeneratorConfig, cliConfig) {
    const dashscopeProvider = new DashScopeOpenAICompatibleProvider(
      contentGeneratorConfig,
      cliConfig
    );
    super(contentGeneratorConfig, cliConfig, dashscopeProvider);
    this.qwenClient = qwenClient;
    this.sharedManager = SharedTokenManager.getInstance();
    if (contentGeneratorConfig?.baseUrl && contentGeneratorConfig?.apiKey) {
      this.pipeline.client.baseURL = contentGeneratorConfig?.baseUrl;
      this.pipeline.client.apiKey = contentGeneratorConfig?.apiKey;
    }
  }
  /**
   * Get the current endpoint URL with proper protocol and /v1 suffix
   */
  getCurrentEndpoint(resourceUrl) {
    const baseEndpoint = resourceUrl || DEFAULT_DASHSCOPE_BASE_URL;
    const suffix = "/v1";
    const normalizedUrl = /^https?:\/\//i.test(baseEndpoint) ? baseEndpoint : `https://${baseEndpoint}`;
    return normalizedUrl.endsWith(suffix) ? normalizedUrl : `${normalizedUrl}${suffix}`;
  }
  /**
   * Override error logging behavior to suppress auth errors during token refresh
   */
  shouldSuppressErrorLogging(error, _request) {
    return this.isAuthError(error);
  }
  /**
   * Get valid token and endpoint using the shared token manager
   */
  async getValidToken() {
    try {
      const credentials = await this.sharedManager.getValidCredentials(
        this.qwenClient
      );
      if (!credentials.access_token) {
        throw new Error("No access token available");
      }
      return {
        token: credentials.access_token,
        endpoint: this.getCurrentEndpoint(credentials.resource_url)
      };
    } catch (error) {
      if (this.isAuthError(error)) {
        throw error;
      }
      this.debugLogger.warn("Failed to get token from shared manager:", error);
      throw new Error(
        "Failed to obtain valid Qwen access token. Please re-authenticate."
      );
    }
  }
  /**
   * Execute an operation with automatic credential management and retry logic.
   * This method handles:
   * - Dynamic token and endpoint retrieval
   * - Client configuration updates
   * - Retry logic on authentication errors with token refresh
   *
   * @param operation - The operation to execute with updated client configuration
   * @returns The result of the operation
   */
  async executeWithCredentialManagement(operation) {
    const attemptOperation = /* @__PURE__ */ __name(async () => {
      const { token, endpoint } = await this.getValidToken();
      this.pipeline.client.apiKey = token;
      this.pipeline.client.baseURL = endpoint;
      return await operation();
    }, "attemptOperation");
    try {
      return await attemptOperation();
    } catch (error) {
      if (this.isAuthError(error)) {
        await this.sharedManager.getValidCredentials(this.qwenClient, true);
        return await attemptOperation();
      }
      throw error;
    }
  }
  /**
   * Override to use dynamic token and endpoint with automatic retry
   */
  async generateContent(request, userPromptId) {
    return this.executeWithCredentialManagement(
      () => super.generateContent(request, userPromptId)
    );
  }
  /**
   * Override to use dynamic token and endpoint with automatic retry
   */
  async generateContentStream(request, userPromptId) {
    return this.executeWithCredentialManagement(
      () => super.generateContentStream(request, userPromptId)
    );
  }
  /**
   * Override to use dynamic token and endpoint with automatic retry
   */
  async embedContent(request) {
    return this.executeWithCredentialManagement(
      () => super.embedContent(request)
    );
  }
  /**
   * Check if an error is related to authentication/authorization
   */
  isAuthError(error) {
    if (!error) return false;
    const errorMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    const errorWithCode = error;
    const errorCode = errorWithCode?.status || errorWithCode?.code;
    return errorCode === 401 || errorCode === 403 || errorCode === "401" || errorCode === "403" || errorMessage.includes("unauthorized") || errorMessage.includes("forbidden") || errorMessage.includes("invalid api key") || errorMessage.includes("invalid access token") || errorMessage.includes("token expired") || errorMessage.includes("authentication") || errorMessage.includes("access denied") || errorMessage.includes("token") && errorMessage.includes("expired");
  }
  /**
   * Get the current cached token (may be expired)
   */
  getCurrentToken() {
    if (this.currentToken) {
      return this.currentToken;
    }
    const credentials = this.sharedManager.getCurrentCredentials();
    return credentials?.access_token || null;
  }
  /**
   * Clear the cached token
   */
  clearToken() {
    this.currentToken = void 0;
    this.sharedManager.clearCache();
  }
};
export {
  QwenContentGenerator
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
