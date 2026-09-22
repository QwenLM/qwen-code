// Force strict mode and setup for ESM
"use strict";
import {
  OmniDeliveryError,
  OmniDownloadError,
  buildAdditionalMediaParts,
  buildTranscriptParts,
  downloadMediaUrl,
  effectiveMaxDownloadFileBytes,
  exportOmniTrajectory,
  parseHttpUrlRef,
  processMediaForOmniDelivery,
  processToolResultOmniMedia,
  readMediaViaOmniDelivery,
  sanitizeErrorMessage,
  serializeOmniTrajectory,
  writeOmniTrajectoryJsonl
} from "./chunk-NCXNBDGJ.js";
import {
  reanchorRememberedMedia
} from "./chunk-DJYHML3Y.js";
import {
  DashScopeUploader,
  OSS_URL_PREFIX,
  resetCredentialCacheForTests
} from "./chunk-V2XJJTAB.js";
import {
  DEFAULT_OMNI_MAX_UPLOAD_FILE_BYTES,
  OmniPolicyExecutionError,
  OmniTransportGuardError,
  assertWithinDurationLimit,
  estimateRawResourceTokens,
  runFixedPolicies
} from "./chunk-DB5RX7EU.js";
import "./chunk-UXEI7POA.js";
import "./chunk-SLHYLVRW.js";
import "./chunk-YDERQ7ZV.js";
import {
  resetRecoveryLatchForTests,
  runStartupRecoveryOnce
} from "./chunk-RSFNJ6UU.js";
import {
  DEFAULT_UPLOAD_CACHE_TTL_HOURS,
  OmniUploadCache
} from "./chunk-JYGESWZM.js";
import "./chunk-TFDCK56Y.js";
import {
  OmniObjectStore
} from "./chunk-FTKXJMQV.js";
import {
  hashFileSha256,
  recognizeMediaFile,
  sniffFileModality,
  sniffMediaType,
  sniffVideoMimeType
} from "./chunk-S5BHLTHK.js";
import {
  assertOmniRuntimeDependencies,
  isFfmpegAvailable,
  isFfprobeAvailable,
  resetFfmpegCachesForTests
} from "./chunk-KSEKRQJO.js";
import "./chunk-6C3D7BKK.js";
import {
  isOmniDeliveryActive
} from "./chunk-ZAQM5T2X.js";
import "./chunk-MNU36NGH.js";
import "./chunk-SATGWSS6.js";
import "./chunk-BQMSZSG6.js";
import {
  OMNI_DISCLOSURE_TEXT_PREFIX,
  OMNI_OMISSION_TEXT_PREFIX,
  OMNI_TRANSCRIPT_TEXT_PREFIX,
  formatDisclosureText,
  formatOmissionText,
  formatResourceHandleText,
  formatTranscriptText,
  isDisclosureText
} from "./chunk-BKVPLSEI.js";
import "./chunk-WNM6BA7E.js";
import "./chunk-TLS6QN2S.js";
import "./chunk-KKPIFWTZ.js";
import "./chunk-NFC4WTY2.js";
import "./chunk-YSD6IY6F.js";
import "./chunk-DJ2GSRLV.js";
import "./chunk-MS4SXNJ6.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-VPGRGNNH.js";
import "./chunk-ERIBG3BX.js";
import "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import "./chunk-UKMWZ5NS.js";
import "./chunk-5O2XNYP6.js";
import "./chunk-J2S4EL5Y.js";
export {
  DEFAULT_OMNI_MAX_UPLOAD_FILE_BYTES,
  DEFAULT_UPLOAD_CACHE_TTL_HOURS,
  DashScopeUploader,
  OMNI_DISCLOSURE_TEXT_PREFIX,
  OMNI_OMISSION_TEXT_PREFIX,
  OMNI_TRANSCRIPT_TEXT_PREFIX,
  OSS_URL_PREFIX,
  OmniDeliveryError,
  OmniDownloadError,
  OmniObjectStore,
  OmniPolicyExecutionError,
  OmniTransportGuardError,
  OmniUploadCache,
  assertOmniRuntimeDependencies,
  assertWithinDurationLimit,
  buildAdditionalMediaParts,
  buildTranscriptParts,
  downloadMediaUrl,
  effectiveMaxDownloadFileBytes,
  estimateRawResourceTokens,
  exportOmniTrajectory,
  formatDisclosureText,
  formatOmissionText,
  formatResourceHandleText,
  formatTranscriptText,
  hashFileSha256,
  isDisclosureText,
  isFfmpegAvailable,
  isFfprobeAvailable,
  isOmniDeliveryActive,
  parseHttpUrlRef,
  processMediaForOmniDelivery,
  processToolResultOmniMedia,
  readMediaViaOmniDelivery,
  reanchorRememberedMedia,
  recognizeMediaFile,
  resetCredentialCacheForTests,
  resetFfmpegCachesForTests,
  resetRecoveryLatchForTests,
  runFixedPolicies,
  runStartupRecoveryOnce,
  sanitizeErrorMessage,
  serializeOmniTrajectory,
  sniffFileModality,
  sniffMediaType,
  sniffVideoMimeType,
  writeOmniTrajectoryJsonl
};
