/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ClientMetadata {
  ideType?: ClientMetadataIdeType;
  ideVersion?: string;
  pluginVersion?: string;
  platform?: ClientMetadataPlatform;
  updateChannel?: string;
  duetProject?: string;
  pluginType?: ClientMetadataPluginType;
  ideName?: string;
}

export type ClientMetadataIdeType =
  | 'IDE_UNSPECIFIED'
  | 'VSCODE'
  | 'INTELLIJ'
  | 'VSCODE_CLOUD_WORKSTATION'
  | 'INTELLIJ_CLOUD_WORKSTATION'
  | 'CLOUD_SHELL'
  | 'GEMINI_CLI';
export type ClientMetadataPlatform =
  | 'PLATFORM_UNSPECIFIED'
  | 'DARWIN_AMD64'
  | 'DARWIN_ARM64'
  | 'LINUX_AMD64'
  | 'LINUX_ARM64'
  | 'WINDOWS_AMD64';
export type ClientMetadataPluginType =
  | 'PLUGIN_UNSPECIFIED'
  | 'CLOUD_CODE'
  | 'GEMINI'
  | 'AIPLUGIN_INTELLIJ'
  | 'AIPLUGIN_STUDIO';

export type CreditType = 'CREDIT_TYPE_UNSPECIFIED' | 'GOOGLE_ONE_AI';

export interface Credits {
  creditType: CreditType;
  creditAmount: string;
}

export interface LoadCodeAssistRequest {
  cloudaicompanionProject?: string;
  metadata: ClientMetadata;
  mode?: LoadCodeAssistMode;
}

export type LoadCodeAssistMode =
  | 'MODE_UNSPECIFIED'
  | 'FULL_ELIGIBILITY_CHECK'
  | 'HEALTH_CHECK';

export interface LoadCodeAssistResponse {
  currentTier?: GeminiUserTier | null;
  allowedTiers?: GeminiUserTier[] | null;
  ineligibleTiers?: IneligibleTier[] | null;
  cloudaicompanionProject?: string | null;
  paidTier?: GeminiUserTier | null;
}

export interface GeminiUserTier {
  id?: UserTierId;
  name?: string;
  description?: string;
  userDefinedCloudaicompanionProject?: boolean | null;
  isDefault?: boolean;
  privacyNotice?: PrivacyNotice;
  hasAcceptedTos?: boolean;
  hasOnboardedPreviously?: boolean;
}

export interface IneligibleTier {
  reasonCode?: IneligibleTierReasonCode;
  reasonMessage?: string;
  tierId?: UserTierId;
  tierName?: string;
  validationErrorMessage?: string;
  validationUrl?: string;
  validationUrlLinkText?: string;
  validationLearnMoreUrl?: string;
  validationLearnMoreLinkText?: string;
}

export enum IneligibleTierReasonCode {
  DASHER_USER = 'DASHER_USER',
  INELIGIBLE_ACCOUNT = 'INELIGIBLE_ACCOUNT',
  NON_USER_ACCOUNT = 'NON_USER_ACCOUNT',
  RESTRICTED_AGE = 'RESTRICTED_AGE',
  RESTRICTED_NETWORK = 'RESTRICTED_NETWORK',
  UNKNOWN = 'UNKNOWN',
  UNKNOWN_LOCATION = 'UNKNOWN_LOCATION',
  UNSUPPORTED_LOCATION = 'UNSUPPORTED_LOCATION',
  VALIDATION_REQUIRED = 'VALIDATION_REQUIRED',
}

export const UserTierId = {
  FREE: 'free-tier',
  LEGACY: 'legacy-tier',
  STANDARD: 'standard-tier',
} as const;

export type UserTierId = (typeof UserTierId)[keyof typeof UserTierId] | string;

export interface PrivacyNotice {
  showNotice?: boolean;
  noticeText?: string;
}

export interface OnboardUserRequest {
  tierId: string | undefined;
  cloudaicompanionProject: string | undefined;
  metadata: ClientMetadata | undefined;
}

export interface LongRunningOperationResponse {
  name?: string;
  done?: boolean;
  response?: OnboardUserResponse;
  error?: {
    code?: number;
    message?: string;
  };
}

export interface OnboardUserResponse {
  cloudaicompanionProject?: {
    id?: string;
    name?: string;
  };
}
