// Force strict mode and setup for ESM
"use strict";
import {
  formatUnsupportedVoiceModelMessage,
  isTranscribableVoiceModel,
  readVoiceLanguage,
  resolveVoiceTransport
} from "./chunk-JYTJ5FCM.js";
import {
  resolvePath
} from "./chunk-UIWUFHRJ.js";
import {
  createDebugLogger,
  isSubpath
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/services/voice-transcriber.ts
init_esbuild_shims();
import process from "node:process";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// packages/cli/src/services/voice-keyterms.ts
init_esbuild_shims();
import * as fs from "node:fs";
import * as path from "node:path";
var GLOBAL_KEYTERMS = [
  "Qwen",
  "MCP",
  "grep",
  "regex",
  "localhost",
  "codebase",
  "TypeScript",
  "JavaScript",
  "JSON",
  "YAML",
  "OAuth",
  "webhook",
  "gRPC",
  "dotfiles",
  "subagent",
  "worktree",
  "stdout",
  "stderr",
  "async",
  "await",
  "API",
  "CLI",
  "npm",
  "pnpm",
  "commit",
  "rebase",
  "refactor",
  "endpoint",
  "middleware",
  "schema",
  "tokenizer"
];
var DEFAULT_KEYTERMS_FILENAME = "voice-keyterms.txt";
var MAX_KEYTERMS = 200;
var MAX_KEYTERMS_BYTES = 2e3;
var MAX_KEYTERMS_FILE_BYTES = 64 * 1024;
function buildVoiceKeyterms(settings) {
  const userTerms = settings ? readUserKeyterms(settings) : [];
  return capKeyterms(dedupeKeyterms([...GLOBAL_KEYTERMS, ...userTerms]));
}
__name(buildVoiceKeyterms, "buildVoiceKeyterms");
function dedupeKeyterms(terms) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const term of terms) {
    const key = term.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(term);
  }
  return out;
}
__name(dedupeKeyterms, "dedupeKeyterms");
function capKeyterms(terms) {
  const out = [];
  let bytes = 0;
  for (const term of terms) {
    if (out.length >= MAX_KEYTERMS) {
      break;
    }
    const next = bytes + Buffer.byteLength(term, "utf8") + (out.length > 0 ? 1 : 0);
    if (next > MAX_KEYTERMS_BYTES) {
      continue;
    }
    out.push(term);
    bytes = next;
  }
  return out;
}
__name(capKeyterms, "capKeyterms");
function readUserKeyterms(settings) {
  if (!settings.isTrusted) {
    return [];
  }
  for (const resolved of resolveKeytermsFiles(settings)) {
    try {
      const file = canonicalizeKeytermsFile(resolved);
      if (!file) {
        continue;
      }
      const content = readRegularFileNoFollow(file);
      if (content === void 0) {
        continue;
      }
      const parsed = parseKeyterms(content);
      if (parsed.length > 0) {
        return parsed;
      }
    } catch {
    }
  }
  return [];
}
__name(readUserKeyterms, "readUserKeyterms");
function resolveKeytermsFiles(settings) {
  const workspacePath = settings.workspace?.path;
  if (!workspacePath) {
    return [];
  }
  const qwenDir = path.dirname(workspacePath);
  const workspaceRoot = path.dirname(qwenDir);
  const configured = readKeytermsFileSettings(settings);
  if (configured.length > 0) {
    return configured.map(({ path: configuredPath, scope }) => {
      const expanded = resolvePath(configuredPath);
      const isAbsolute2 = path.isAbsolute(expanded);
      return {
        filePath: isAbsolute2 ? expanded : path.resolve(workspaceRoot, expanded),
        workspaceRoot,
        mustBeInWorkspace: scope === "system" || !isAbsolute2
      };
    });
  }
  return [
    {
      filePath: path.join(qwenDir, DEFAULT_KEYTERMS_FILENAME),
      workspaceRoot,
      mustBeInWorkspace: true
    }
  ];
}
__name(resolveKeytermsFiles, "resolveKeytermsFiles");
function canonicalizeKeytermsFile({
  filePath,
  workspaceRoot,
  mustBeInWorkspace
}) {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1 || stat.size > MAX_KEYTERMS_FILE_BYTES) {
    return void 0;
  }
  const realFilePath = fs.realpathSync(filePath);
  if (mustBeInWorkspace) {
    const realWorkspaceRoot = fs.realpathSync(workspaceRoot);
    if (!isSubpath(realWorkspaceRoot, realFilePath)) {
      return void 0;
    }
  }
  return { filePath: realFilePath, stat };
}
__name(canonicalizeKeytermsFile, "canonicalizeKeytermsFile");
function readRegularFileNoFollow({
  filePath,
  stat: expectedStat
}) {
  let fd;
  try {
    let flags = fs.constants.O_RDONLY;
    if (typeof fs.constants.O_NOFOLLOW === "number") {
      flags |= fs.constants.O_NOFOLLOW;
    }
    if (typeof fs.constants.O_NONBLOCK === "number") {
      flags |= fs.constants.O_NONBLOCK;
    }
    fd = fs.openSync(filePath, flags);
    const stat = fs.fstatSync(fd);
    if (stat.dev !== expectedStat.dev || stat.ino !== expectedStat.ino || stat.mode !== expectedStat.mode || stat.size !== expectedStat.size || stat.mtimeMs !== expectedStat.mtimeMs || stat.ctimeMs !== expectedStat.ctimeMs || !stat.isFile() || stat.nlink > 1 || stat.size > MAX_KEYTERMS_FILE_BYTES) {
      return void 0;
    }
    const content = fs.readFileSync(fd, "utf-8");
    if (Buffer.byteLength(content, "utf8") > MAX_KEYTERMS_FILE_BYTES) {
      return void 0;
    }
    return content;
  } finally {
    if (fd !== void 0) {
      fs.closeSync(fd);
    }
  }
}
__name(readRegularFileNoFollow, "readRegularFileNoFollow");
function parseKeyterms(content) {
  return content.split(/\r?\n/).map((line) => line.replace(/^\s*#.*$/, "").trim()).filter((line) => line.length > 0);
}
__name(parseKeyterms, "parseKeyterms");
function readKeytermsFileSettings(settings) {
  const out = [];
  const system = readKeytermsFileSettingFromScope(settings.system?.settings);
  if (system) {
    out.push({ path: system, scope: "system" });
  }
  const user = readKeytermsFileSettingFromScope(settings.user?.settings);
  if (user) {
    out.push({ path: user, scope: "user" });
  }
  return out;
}
__name(readKeytermsFileSettings, "readKeytermsFileSettings");
function readKeytermsFileSettingFromScope(settings) {
  const value = settings?.general?.voice?.keytermsFile;
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
__name(readKeytermsFileSettingFromScope, "readKeytermsFileSettingFromScope");

// packages/cli/src/services/voice-transcriber.ts
var DEFAULT_OPENAI_API_KEY = "OPENAI_API_KEY";
var INFERENCE_TIMEOUT_MS = 6e4;
var MIN_KEYTERM_ECHO_TOKENS = 8;
var MIN_ABSOLUTE_KEYTERM_ECHO_TOKENS = 10;
var MIN_KEYTERM_SET_ECHO_RATIO = 0.3;
var debugLogger = createDebugLogger("VOICE_TRANSCRIBER");
var BLOCKED_TRANSITION_IPV6_ADDRESSES = new BlockList();
for (const [address, prefix] of [
  ["64:ff9b:1::", 48],
  ["2001::", 23],
  ["2002::", 16]
]) {
  BLOCKED_TRANSITION_IPV6_ADDRESSES.addSubnet(address, prefix, "ipv6");
}
function trimTrailingSlashes(value) {
  return value.replace(/\/+$/, "");
}
__name(trimTrailingSlashes, "trimTrailingSlashes");
function readSettingsEnv(settings, envKey) {
  const env = settings.merged.env;
  const value = env?.[envKey];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
__name(readSettingsEnv, "readSettingsEnv");
function isQwenBaseUrl(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "dashscope.aliyuncs.com" || hostname === "dashscope-intl.aliyuncs.com" || hostname === "dashscope-us.aliyuncs.com" || hostname.endsWith(".dashscope.aliyuncs.com") || hostname.endsWith(".dashscope-intl.aliyuncs.com") || hostname.endsWith(".dashscope-us.aliyuncs.com");
  } catch {
    return false;
  }
}
__name(isQwenBaseUrl, "isQwenBaseUrl");
function normalizeBaseUrl(baseUrl, modelName) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Voice model '${modelName}' has an invalid baseUrl.`);
  }
  if (url.username || url.password) {
    throw new Error(
      `Voice model '${modelName}' baseUrl must not contain embedded credentials.`
    );
  }
  return trimTrailingSlashes(url.toString());
}
__name(normalizeBaseUrl, "normalizeBaseUrl");
function normalizeAllowedVoiceBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl.trim());
    if (url.username || url.password) {
      return void 0;
    }
    return trimTrailingSlashes(url.toString());
  } catch {
    return void 0;
  }
}
__name(normalizeAllowedVoiceBaseUrl, "normalizeAllowedVoiceBaseUrl");
function isInsecureVoiceBaseUrlAllowed(settings, normalizedBaseUrl) {
  const allowed = settings.merged.security?.allowedInsecureVoiceBaseUrls;
  return Array.isArray(allowed) && allowed.some(
    (candidate) => typeof candidate === "string" && normalizeAllowedVoiceBaseUrl(candidate) === normalizedBaseUrl
  );
}
__name(isInsecureVoiceBaseUrlAllowed, "isInsecureVoiceBaseUrlAllowed");
function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}
__name(normalizeHostname, "normalizeHostname");
function normalizeIpAddress(address) {
  const host = normalizeHostname(address);
  if (isIP(host) !== 6) {
    return host;
  }
  try {
    return normalizeHostname(new URL(`http://[${host}]/`).hostname);
  } catch {
    return host;
  }
}
__name(normalizeIpAddress, "normalizeIpAddress");
function isLoopbackHost(hostname) {
  const host = normalizeHostname(hostname);
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
__name(isLoopbackHost, "isLoopbackHost");
function isAwsIpv6MetadataAddress(hostname) {
  const host = normalizeHostname(hostname);
  if (isIP(host) !== 6) {
    return false;
  }
  try {
    return normalizeHostname(new URL(`http://[${host}]/`).hostname) === "fd00:ec2::254";
  } catch {
    return false;
  }
}
__name(isAwsIpv6MetadataAddress, "isAwsIpv6MetadataAddress");
function readIpv4CompatibleIpv6(host) {
  if (!host.startsWith("::") || host.startsWith("::ffff:")) {
    return void 0;
  }
  const parts = host.slice(2).split(":");
  if (parts.length === 0 || parts.length > 2 || parts.some((part) => !part)) {
    return void 0;
  }
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) {
    return void 0;
  }
  const hextets = parts.map((part) => Number.parseInt(part, 16));
  const value = hextets.length === 1 ? hextets[0] : hextets[0] << 16 | hextets[1];
  return [
    value >>> 24 & 255,
    value >>> 16 & 255,
    value >>> 8 & 255,
    value & 255
  ].join(".");
}
__name(readIpv4CompatibleIpv6, "readIpv4CompatibleIpv6");
function readIpv4MappedIpv6(host) {
  const dotted = host.match(/^::ffff:(\d+(?:\.\d+){3})$/i);
  if (dotted && isIP(dotted[1]) === 4) {
    return dotted[1];
  }
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) {
    return void 0;
  }
  return readIpv4HexPair(hex[1], hex[2]);
}
__name(readIpv4MappedIpv6, "readIpv4MappedIpv6");
function readIpv4HexPair(highHex, lowHex) {
  const high = Number.parseInt(highHex, 16);
  const low = Number.parseInt(lowHex, 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join(".");
}
__name(readIpv4HexPair, "readIpv4HexPair");
function readWellKnownNat64Ipv6(host) {
  const prefix = "64:ff9b::";
  if (!host.startsWith(prefix)) {
    return void 0;
  }
  const suffix = host.slice(prefix.length);
  if (!suffix) {
    return "0.0.0.0";
  }
  const groups = suffix.split(":");
  if (groups.length > 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return void 0;
  }
  return groups.length === 1 ? readIpv4HexPair("0", groups[0]) : readIpv4HexPair(groups[0], groups[1]);
}
__name(readWellKnownNat64Ipv6, "readWellKnownNat64Ipv6");
function isBlockedTransitionIpv6Address(host) {
  return isIP(host) === 6 && BLOCKED_TRANSITION_IPV6_ADDRESSES.check(host, "ipv6");
}
__name(isBlockedTransitionIpv6Address, "isBlockedTransitionIpv6Address");
function unwrapIpv6TransitionStep(host) {
  const ipv4Mapped = readIpv4MappedIpv6(host);
  if (ipv4Mapped) {
    return { address: ipv4Mapped };
  }
  const ipv4Compatible = readIpv4CompatibleIpv6(host);
  if (ipv4Compatible) {
    return { address: ipv4Compatible };
  }
  const nat64 = readWellKnownNat64Ipv6(host);
  if (nat64) {
    return { address: nat64 };
  }
  if (host.startsWith("::ffff:")) {
    return "blocked";
  }
  return void 0;
}
__name(unwrapIpv6TransitionStep, "unwrapIpv6TransitionStep");
function isPrivateNetworkIp(hostname) {
  const host = normalizeIpAddress(hostname);
  if (isBlockedTransitionIpv6Address(host)) {
    return true;
  }
  if (isLoopbackHost(host)) {
    return false;
  }
  const step = unwrapIpv6TransitionStep(host);
  if (step === "blocked") {
    return true;
  }
  if (step) {
    return isPrivateNetworkIp(step.address);
  }
  if (isIP(host) === 4) {
    const [first = 0, second = 0] = host.split(".").map(Number);
    return first === 0 || first === 10 || first === 127 || first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168 || first === 100 && second >= 64 && second <= 127;
  }
  if (isIP(host) === 6) {
    const firstHextet = Number.parseInt(host.split(":", 1)[0] || "0", 16);
    return host === "::" || (firstHextet & 65472) === 65152 || (firstHextet & 65024) === 64512;
  }
  return false;
}
__name(isPrivateNetworkIp, "isPrivateNetworkIp");
function isAlwaysBlockedVoiceAddress(address) {
  const host = normalizeIpAddress(address);
  if (isBlockedTransitionIpv6Address(host)) {
    return true;
  }
  if (isLoopbackHost(host)) {
    return true;
  }
  const step = unwrapIpv6TransitionStep(host);
  if (step === "blocked") {
    return true;
  }
  if (step) {
    return isAlwaysBlockedVoiceAddress(step.address);
  }
  if (isIP(host) === 4) {
    const [first = 0, second = 0] = host.split(".").map(Number);
    return first === 0 || first === 127 || first === 169 && second === 254 || host === "100.100.100.200";
  }
  if (isIP(host) === 6) {
    const firstHextet = Number.parseInt(host.split(":", 1)[0] || "0", 16);
    return host === "::" || isAwsIpv6MetadataAddress(host) || (firstHextet & 65472) === 65152;
  }
  return false;
}
__name(isAlwaysBlockedVoiceAddress, "isAlwaysBlockedVoiceAddress");
function isLoopbackVoiceAddress(address) {
  const host = normalizeIpAddress(address);
  if (isLoopbackHost(host)) {
    return true;
  }
  const step = unwrapIpv6TransitionStep(host);
  if (step && step !== "blocked") {
    return isLoopbackVoiceAddress(step.address);
  }
  if (isIP(host) === 4) {
    return host.startsWith("127.");
  }
  return false;
}
__name(isLoopbackVoiceAddress, "isLoopbackVoiceAddress");
async function defaultLookupHost(hostname) {
  return dnsLookup(hostname, { all: true });
}
__name(defaultLookupHost, "defaultLookupHost");
async function assertVoiceBaseUrlNetworkAllowed(voiceConfig, lookupHost, abortSignal) {
  const hostname = normalizeHostname(new URL(voiceConfig.baseUrl).hostname);
  if (isLoopbackHost(hostname)) {
    return;
  }
  if (isIP(hostname) !== 0) {
    if (isAlwaysBlockedVoiceAddress(hostname) || !voiceConfig.allowInsecureBaseUrl && isPrivateNetworkIp(hostname)) {
      throw new Error(
        isLoopbackVoiceAddress(hostname) ? `Voice model '${voiceConfig.model}' uses a loopback address outside the accepted spellings. To use a local ASR endpoint, set the baseUrl to http://localhost, http://127.0.0.1, or http://[::1].` : `Voice model '${voiceConfig.model}' resolved to a private-network address.`
      );
    }
    return;
  }
  let result;
  let onAbort;
  try {
    if (abortSignal?.aborted) {
      throw abortSignal.reason;
    }
    const lookup = (lookupHost ?? defaultLookupHost)(hostname);
    result = abortSignal ? await Promise.race([
      lookup,
      new Promise((_resolve, reject) => {
        onAbort = /* @__PURE__ */ __name(() => reject(abortSignal.reason), "onAbort");
        if (abortSignal.aborted) onAbort();
        else abortSignal.addEventListener("abort", onAbort, { once: true });
      })
    ]) : await lookup;
  } catch {
    if (abortSignal?.aborted) {
      throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("Voice request was aborted.");
    }
    throw new Error(
      `Voice model '${voiceConfig.model}': DNS lookup failed for ${hostname}. Cannot verify network safety.`
    );
  } finally {
    if (onAbort) abortSignal?.removeEventListener("abort", onAbort);
  }
  const records = Array.isArray(result) ? result : [result];
  if (records.some(
    (record) => isAlwaysBlockedVoiceAddress(record.address) || !voiceConfig.allowInsecureBaseUrl && isPrivateNetworkIp(record.address)
  )) {
    throw new Error(
      records.some((record) => isLoopbackVoiceAddress(record.address)) ? `Voice model '${voiceConfig.model}' resolved to a loopback address. Loopback DNS results are always blocked; to use a local ASR endpoint, configure an explicit loopback baseUrl: http://localhost, http://127.0.0.1, or http://[::1].` : voiceConfig.allowInsecureBaseUrl && records.some(
        (record) => isAlwaysBlockedVoiceAddress(record.address)
      ) ? `Voice model '${voiceConfig.model}' resolved to an address that is always blocked (metadata, link-local, or transition range), even when the baseUrl is listed in security.allowedInsecureVoiceBaseUrls.` : `Voice model '${voiceConfig.model}' resolved to a private-network address.`
    );
  }
}
__name(assertVoiceBaseUrlNetworkAllowed, "assertVoiceBaseUrlNetworkAllowed");
function readApiKey(settings, model, baseUrl, env) {
  if (!model.envKey && !isQwenBaseUrl(baseUrl)) {
    return void 0;
  }
  const envKey = model.envKey ?? DEFAULT_OPENAI_API_KEY;
  const envSource = env ?? process.env;
  const envValue = Object.hasOwn(envSource, envKey) ? envSource[envKey] : void 0;
  if (envValue && envValue.trim().length > 0) {
    return envValue.trim();
  }
  const settingsEnvValue = readSettingsEnv(settings, envKey);
  if (settingsEnvValue) {
    return settingsEnvValue;
  }
  if (!model.envKey && isQwenBaseUrl(baseUrl)) {
    const authApiKey = settings.merged.security?.auth?.apiKey;
    return typeof authApiKey === "string" && authApiKey.trim().length > 0 ? authApiKey.trim() : void 0;
  }
  return void 0;
}
__name(readApiKey, "readApiKey");
function resolveVoiceTranscriptionConfig({
  config,
  settings,
  voiceModel,
  env
}) {
  const matches = config.getAllConfiguredModels().filter((model2) => model2.id === voiceModel);
  if (matches.length === 0) {
    throw new Error(
      `Voice model '${voiceModel}' is not configured. Run /model --voice to choose a configured model.`
    );
  }
  if (matches.length > 1) {
    throw new Error(`Voice model '${voiceModel}' is ambiguous.`);
  }
  const model = matches[0];
  if (!isTranscribableVoiceModel(model)) {
    throw new Error(formatUnsupportedVoiceModelMessage(voiceModel));
  }
  const baseUrl = model.baseUrl?.trim();
  if (!baseUrl) {
    throw new Error(`Voice model '${voiceModel}' does not define a baseUrl.`);
  }
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl, voiceModel);
  const parsedBaseUrl = new URL(normalizedBaseUrl);
  const isLocalhost = isLoopbackHost(parsedBaseUrl.hostname);
  const allowInsecureBaseUrl = isInsecureVoiceBaseUrlAllowed(
    settings,
    normalizedBaseUrl
  );
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new Error(
      `Voice model '${voiceModel}' must use an http or https baseUrl.`
    );
  }
  if (!isLocalhost && isAlwaysBlockedVoiceAddress(parsedBaseUrl.hostname)) {
    throw new Error(
      isLoopbackVoiceAddress(parsedBaseUrl.hostname) ? `Voice model '${voiceModel}' uses a loopback address outside the accepted spellings. To use a local ASR endpoint, set the baseUrl to http://localhost, http://127.0.0.1, or http://[::1].` : `Voice model '${voiceModel}' must not use a private-network baseUrl.`
    );
  }
  if (parsedBaseUrl.protocol !== "https:" && !isLocalhost && !allowInsecureBaseUrl) {
    throw new Error(
      `Voice model '${voiceModel}' must use an https baseUrl. Voice audio must not be transmitted in cleartext. To trust this managed endpoint, add its exact complete normalized URL (${normalizedBaseUrl}) to security.allowedInsecureVoiceBaseUrls. This setting is only honored from User, System, or SystemDefaults scope settings; Workspace entries are ignored.`
    );
  }
  if (!isLocalhost && !allowInsecureBaseUrl && isPrivateNetworkIp(parsedBaseUrl.hostname)) {
    throw new Error(
      `Voice model '${voiceModel}' must not use a private-network baseUrl. To trust this managed endpoint, add its exact complete normalized URL (${normalizedBaseUrl}) to security.allowedInsecureVoiceBaseUrls. This setting is only honored from User, System, or SystemDefaults scope settings; Workspace entries are ignored.`
    );
  }
  const apiKey = readApiKey(settings, model, normalizedBaseUrl, env);
  if (model.envKey && !apiKey) {
    throw new Error(`Voice model '${voiceModel}' requires ${model.envKey}.`);
  }
  return {
    model: voiceModel,
    baseUrl: normalizedBaseUrl,
    ...apiKey ? { apiKey } : {},
    ...allowInsecureBaseUrl ? { allowInsecureBaseUrl: true } : {}
  };
}
__name(resolveVoiceTranscriptionConfig, "resolveVoiceTranscriptionConfig");
function isStreamingVoiceModel(model) {
  const transport = resolveVoiceTransport(model);
  return transport === "qwen-asr-realtime" || transport === "dashscope-task-realtime";
}
__name(isStreamingVoiceModel, "isStreamingVoiceModel");
function resolveVoiceStreamConfig(args) {
  const base = resolveVoiceTranscriptionConfig(args);
  const transport = resolveVoiceTransport(base.model);
  if (transport !== "qwen-asr-realtime" && transport !== "dashscope-task-realtime") {
    throw new Error(
      `Voice model '${base.model}' does not support streaming transcription.`
    );
  }
  const language = resolveLanguageCode(readVoiceLanguage(args.settings));
  const keytermsContext = transport === "qwen-asr-realtime" ? buildKeytermsContext(args.settings) : void 0;
  return {
    transport,
    baseUrl: base.baseUrl,
    model: base.model,
    ...base.apiKey ? { apiKey: base.apiKey } : {},
    ...base.allowInsecureBaseUrl ? { allowInsecureBaseUrl: true } : {},
    ...language ? { language } : {},
    ...keytermsContext ? { keytermsContext } : {}
  };
}
__name(resolveVoiceStreamConfig, "resolveVoiceStreamConfig");
var LANGUAGE_CODES = {
  english: "en",
  chinese: "zh",
  mandarin: "zh",
  cantonese: "yue",
  japanese: "ja",
  korean: "ko",
  french: "fr",
  german: "de",
  spanish: "es",
  italian: "it",
  portuguese: "pt",
  russian: "ru",
  arabic: "ar"
};
function resolveLanguageCode(language) {
  if (!language) {
    return void 0;
  }
  const lower = language.toLowerCase();
  if (LANGUAGE_CODES[lower]) {
    return LANGUAGE_CODES[lower];
  }
  return /^[a-z]{2,3}$/.test(lower) ? lower : void 0;
}
__name(resolveLanguageCode, "resolveLanguageCode");
function buildKeytermsContext(settings) {
  try {
    const keyterms = buildVoiceKeyterms(settings);
    return keyterms.length > 0 ? keyterms.join(" ") : void 0;
  } catch {
    return void 0;
  }
}
__name(buildKeytermsContext, "buildKeytermsContext");
function tokenize(value) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}
__name(tokenize, "tokenize");
function isKeytermEcho(transcript, keytermsContext) {
  if (!keytermsContext) {
    return false;
  }
  const tokens = tokenize(transcript);
  if (tokens.length < 4) {
    return false;
  }
  const keyset = new Set(tokenize(keytermsContext));
  const overlap = tokens.filter((t) => keyset.has(t)).length;
  const transcriptRatio = overlap / tokens.length;
  const keytermRatio = overlap / keyset.size;
  const isEcho = overlap >= MIN_KEYTERM_ECHO_TOKENS && transcriptRatio >= 0.9 && (keytermRatio >= MIN_KEYTERM_SET_ECHO_RATIO || overlap >= MIN_ABSOLUTE_KEYTERM_ECHO_TOKENS);
  if (isEcho) {
    const branch = keytermRatio >= MIN_KEYTERM_SET_ECHO_RATIO ? "ratio" : "absolute";
    debugLogger.debug(
      `[voice] dropped likely keyterm echo (${branch}): overlap=${overlap} keysetSize=${keyset.size} transcriptRatio=${transcriptRatio.toFixed(2)} keytermRatio=${keytermRatio.toFixed(2)} text="${transcript}"`
    );
  }
  return isEcho;
}
__name(isKeytermEcho, "isKeytermEcho");
var MAX_AUDIO_BYTES = 10 * 1024 * 1024;
var MAX_TRANSCRIPTION_ERROR_LENGTH = 200;
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
__name(escapeRegExp, "escapeRegExp");
function sanitizeVoiceErrorMessage(raw, apiKey) {
  let redacted = raw.replace(
    /Authorization:\s*(?:Bearer|ApiKey|Basic|Token)?\s*\S+/gi,
    "Authorization: [REDACTED]"
  ).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/\b(?:api[-_ ]?key|token|secret)=\S+/gi, "[REDACTED]").replace(/\bsk-[A-Za-z0-9._-]{4,}\b/g, "[REDACTED]");
  if (apiKey) {
    redacted = redacted.replace(
      new RegExp(escapeRegExp(apiKey), "g"),
      "[REDACTED]"
    );
  }
  return redacted.length > MAX_TRANSCRIPTION_ERROR_LENGTH ? `${redacted.slice(0, MAX_TRANSCRIPTION_ERROR_LENGTH)}...` : redacted;
}
__name(sanitizeVoiceErrorMessage, "sanitizeVoiceErrorMessage");
function inputAudioFormat(mimeType) {
  const subtype = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return subtype.startsWith("audio/") ? subtype.slice("audio/".length) || "wav" : "wav";
}
__name(inputAudioFormat, "inputAudioFormat");
function transcriptionAbortSignal(abortSignal) {
  const timeoutSignal = AbortSignal.timeout(INFERENCE_TIMEOUT_MS);
  return abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;
}
__name(transcriptionAbortSignal, "transcriptionAbortSignal");
async function transcribeViaQwenAsr(audio, voiceConfig, options, fetchFn) {
  if (audio.data.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(
      "Recording is too long for transcription (max ~5 minutes / 10 MB). Try a shorter dictation."
    );
  }
  const dataUrl = `data:${audio.mimeType};base64,${Buffer.from(audio.data).toString("base64")}`;
  const messages = [];
  if (options.keytermsContext) {
    messages.push({
      role: "system",
      content: [{ type: "text", text: options.keytermsContext }]
    });
  }
  messages.push({
    role: "user",
    content: [
      {
        type: "input_audio",
        input_audio: {
          data: dataUrl,
          format: inputAudioFormat(audio.mimeType)
        }
      }
    ]
  });
  const asrOptions = { enable_itn: true };
  if (options.language) {
    asrOptions["language"] = options.language;
  }
  const headers = {
    "Content-Type": "application/json"
  };
  if (voiceConfig.apiKey) {
    headers["Authorization"] = `Bearer ${voiceConfig.apiKey}`;
  }
  let response;
  try {
    options.onEgress?.();
    response = await fetchFn(
      `${trimTrailingSlashes(voiceConfig.baseUrl)}/chat/completions`,
      {
        method: "POST",
        headers,
        redirect: "manual",
        body: JSON.stringify({
          model: voiceConfig.model,
          messages,
          asr_options: asrOptions
        }),
        signal: transcriptionAbortSignal(options.abortSignal)
      }
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(
        `Voice transcription timed out after ${INFERENCE_TIMEOUT_MS / 1e3}s. Check ASR service health and retry.`
      );
    }
    throw error;
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Voice transcription request redirected.");
  }
  if (!response.ok) {
    let details = "";
    try {
      details = sanitizeVoiceErrorMessage(
        await response.text(),
        voiceConfig.apiKey
      );
    } catch {
      details = "";
    }
    if (/model_not_supported|unsupported model/i.test(details)) {
      throw new Error(
        "This voice model cannot be used for batch transcription. Use qwen3-asr-flash for batch or choose a realtime voice model such as qwen3-asr-flash-realtime / fun-asr-realtime / paraformer-realtime-v2."
      );
    }
    const suffix = details ? `: ${details}` : "";
    throw new Error(
      `Voice transcription request failed (${response.status} ${response.statusText})${suffix}`
    );
  }
  const json = await response.json();
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("Voice transcription response did not include text.");
  }
  const text = content.trim();
  if (isKeytermEcho(text, options.keytermsContext)) {
    return "";
  }
  return text;
}
__name(transcribeViaQwenAsr, "transcribeViaQwenAsr");
async function transcribeVoiceAudio(audio, args) {
  const voiceConfig = resolveVoiceTranscriptionConfig(args);
  await assertVoiceBaseUrlNetworkAllowed(
    voiceConfig,
    args.lookupHost,
    args.abortSignal
  );
  const fetchFn = args.fetchFn ?? fetch;
  const language = resolveLanguageCode(readVoiceLanguage(args.settings));
  const keytermsContext = buildKeytermsContext(args.settings);
  const transport = resolveVoiceTransport(voiceConfig.model);
  switch (transport) {
    case "qwen-asr-chat":
      return transcribeViaQwenAsr(
        audio,
        voiceConfig,
        {
          language,
          keytermsContext,
          abortSignal: args.abortSignal,
          ...args.onEgress ? { onEgress: args.onEgress } : {}
        },
        fetchFn
      );
    case "qwen-asr-realtime":
    case "dashscope-task-realtime":
      throw new Error(
        `Voice model '${voiceConfig.model}' requires streaming transcription.`
      );
    case "unsupported":
    default:
      throw new Error(
        `Voice model '${voiceConfig.model}' is not a supported transcription model.`
      );
  }
}
__name(transcribeVoiceAudio, "transcribeVoiceAudio");

export {
  assertVoiceBaseUrlNetworkAllowed,
  resolveVoiceTranscriptionConfig,
  isStreamingVoiceModel,
  resolveVoiceStreamConfig,
  isKeytermEcho,
  MAX_AUDIO_BYTES,
  sanitizeVoiceErrorMessage,
  transcribeVoiceAudio
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
