// Force strict mode and setup for ESM
"use strict";
import {
  getGlobalQwenDir
} from "./chunk-PZRXWQUA.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/channels/weixin/dist/accounts.js
init_esbuild_shims();
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
var DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
function getStateDir() {
  const dir = process.env["WEIXIN_STATE_DIR"] || join(getGlobalQwenDir(), "channels", "weixin");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
__name(getStateDir, "getStateDir");
function accountPath() {
  return join(getStateDir(), "account.json");
}
__name(accountPath, "accountPath");
function loadAccount() {
  const p = accountPath();
  if (!existsSync(p))
    return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}
__name(loadAccount, "loadAccount");
function saveAccount(data) {
  const p = accountPath();
  const tmp = `${p}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), {
      encoding: "utf-8",
      mode: 384,
      flag: "wx"
    });
    renameSync(tmp, p);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw e;
  }
}
__name(saveAccount, "saveAccount");
function clearAccount() {
  const dir = getStateDir();
  const p = join(dir, "account.json");
  if (existsSync(p)) {
    unlinkSync(p);
  }
  for (const f of readdirSync(dir)) {
    if (f.startsWith("account.json.") && f.endsWith(".tmp")) {
      try {
        unlinkSync(join(dir, f));
      } catch {
      }
    }
  }
}
__name(clearAccount, "clearAccount");

// packages/channels/weixin/dist/api.js
init_esbuild_shims();
var WeixinApiError = class extends Error {
  static {
    __name(this, "WeixinApiError");
  }
  /** HTTP status code (0 if network/timeout error). */
  status;
  /** API-level return code (ret field in response body). */
  ret;
  /** API-level error code (errcode field in response body). */
  errcode;
  constructor(message, status, ret, errcode) {
    super(message);
    this.name = "WeixinApiError";
    this.status = status;
    this.ret = ret;
    this.errcode = errcode;
  }
};
function isRetryableError(err) {
  if (err instanceof WeixinApiError) {
    if (err.errcode === -14)
      return false;
    if (err.errcode === -1 || err.errcode === 45011)
      return true;
    if (err.ret !== void 0 && err.ret !== 0)
      return false;
    if (err.status >= 400 && err.status < 500)
      return err.status === 429;
    return err.status === 0 || err.status >= 500;
  }
  if (err instanceof TypeError || err.code) {
    return true;
  }
  return false;
}
__name(isRetryableError, "isRetryableError");
async function retryWithBackoff(fn, maxRetries = 3, baseDelayMs = 1e3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt > maxRetries || !isRetryableError(err)) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
__name(retryWithBackoff, "retryWithBackoff");
var ILINK_PROTOCOL_VERSION = "2.1.3";
function buildClientVersion(version) {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return (major & 255) << 16 | (minor & 255) << 8 | patch & 255;
}
__name(buildClientVersion, "buildClientVersion");
function baseInfo() {
  return { channel_version: ILINK_PROTOCOL_VERSION };
}
__name(baseInfo, "baseInfo");
function randomUin() {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf));
}
__name(randomUin, "randomUin");
function buildHeaders(token) {
  const headers = {
    "Content-Type": "application/json",
    "X-WECHAT-UIN": randomUin(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(buildClientVersion(ILINK_PROTOCOL_VERSION))
  };
  if (token) {
    headers["AuthorizationType"] = "ilink_bot_token";
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}
__name(buildHeaders, "buildHeaders");
async function post(baseUrl, path, body, token, timeoutMs = 4e4, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const resp = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!resp.ok) {
      let ret;
      let errcode;
      let errmsg;
      try {
        const errBody = await resp.json();
        ret = errBody.ret;
        errcode = errBody.errcode;
        errmsg = errBody.errmsg;
      } catch {
      }
      const message = errmsg ? `WeChat API error (HTTP ${resp.status}, ret=${ret}, errcode=${errcode}): ${errmsg}` : `WeChat API error (HTTP ${resp.status})`;
      throw new WeixinApiError(message, resp.status, ret, errcode);
    }
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
}
__name(post, "post");
async function getUpdates(baseUrl, token, getUpdatesBuf, timeoutMs = 4e4, signal) {
  const body = {
    get_updates_buf: getUpdatesBuf,
    base_info: baseInfo()
  };
  try {
    return await post(baseUrl, "/ilink/bot/getupdates", body, token, timeoutMs, signal);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}
__name(getUpdates, "getUpdates");
async function sendMessage(baseUrl, token, msg) {
  const body = { msg, base_info: baseInfo() };
  await retryWithBackoff(async (_attempt) => {
    const resp = await post(baseUrl, "/ilink/bot/sendmessage", body, token);
    if (resp.ret !== void 0 && resp.ret !== 0 || resp.errcode !== void 0 && resp.errcode !== 0) {
      throw new WeixinApiError(`sendMessage failed: ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg || ""}`, 200, resp.ret, resp.errcode);
    }
  });
}
__name(sendMessage, "sendMessage");
async function getConfig(baseUrl, token, userId, contextToken) {
  const body = {
    ilink_user_id: userId,
    context_token: contextToken,
    base_info: baseInfo()
  };
  return post(baseUrl, "/ilink/bot/getconfig", body, token);
}
__name(getConfig, "getConfig");
async function sendTyping(baseUrl, token, req) {
  const body = { ...req, base_info: baseInfo() };
  return post(baseUrl, "/ilink/bot/sendtyping", body, token);
}
__name(sendTyping, "sendTyping");
async function getUploadUrl(baseUrl, token, toUserId, filekey, rawsize, rawfilemd5, encryptedSize, aeskeyHex) {
  const body = {
    filekey,
    media_type: 1,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize: encryptedSize,
    no_need_thumb: true,
    aeskey: aeskeyHex,
    base_info: baseInfo()
  };
  return retryWithBackoff(async (_attempt) => {
    const resp = await post(baseUrl, "/ilink/bot/getuploadurl", body, token);
    if (resp.ret !== void 0 && resp.ret !== 0 || resp.errcode !== void 0 && resp.errcode !== 0) {
      throw new WeixinApiError(`getuploadurl failed: ret=${resp.ret} errcode=${resp.errcode ?? "(none)"} errmsg=${resp.errmsg || "(none)"}`, 200, resp.ret, resp.errcode);
    }
    if (resp.upload_full_url) {
      return resp.upload_full_url;
    }
    if (resp.upload_param) {
      return resp.upload_param;
    }
    throw new WeixinApiError(`getuploadurl returned no URL: ret=${resp.ret} errcode=${resp.errcode ?? "(none)"} errmsg=${resp.errmsg || "(none)"}`, 200, resp.ret, resp.errcode);
  });
}
__name(getUploadUrl, "getUploadUrl");
async function uploadToCdn(urlOrParam, filekey, encryptedData) {
  const CDN_HOST = "novac2c.cdn.weixin.qq.com";
  let url;
  const lowerUrlOrParam = urlOrParam.toLowerCase();
  if (lowerUrlOrParam.startsWith("https://")) {
    const parsed = new URL(urlOrParam);
    if (parsed.hostname !== CDN_HOST) {
      throw new Error(`CDN upload URL has unexpected host: ${parsed.hostname}`);
    }
    url = urlOrParam;
  } else if (lowerUrlOrParam.startsWith("http://")) {
    throw new Error("CDN upload URL must use HTTPS");
  } else {
    url = `https://${CDN_HOST}/c2c/upload?encrypted_query_param=${encodeURIComponent(urlOrParam)}&filekey=${encodeURIComponent(filekey)}`;
  }
  return retryWithBackoff(async (_attempt) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4e4);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: encryptedData,
        signal: controller.signal
      });
      if (!resp.ok) {
        let cdnErrMsg;
        let cdnRet;
        let cdnErrCode;
        try {
          const errBody = await resp.json();
          cdnErrMsg = errBody.errmsg;
          cdnRet = errBody.ret;
          cdnErrCode = errBody.errcode;
        } catch {
        }
        throw new WeixinApiError(cdnErrMsg ? `CDN upload failed: HTTP ${resp.status} \u2014 ${cdnErrMsg}` : `CDN upload failed: HTTP ${resp.status}`, resp.status, cdnRet, cdnErrCode);
      }
      const encryptParam = resp.headers.get("x-encrypted-param");
      if (!encryptParam) {
        throw new WeixinApiError("CDN upload succeeded but missing x-encrypted-param header", resp.status);
      }
      return encryptParam;
    } finally {
      clearTimeout(timeout);
    }
  });
}
__name(uploadToCdn, "uploadToCdn");

export {
  DEFAULT_BASE_URL,
  getStateDir,
  loadAccount,
  saveAccount,
  clearAccount,
  WeixinApiError,
  buildHeaders,
  getUpdates,
  sendMessage,
  getConfig,
  sendTyping,
  getUploadUrl,
  uploadToCdn
};
