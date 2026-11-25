/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const QODER_ERROR_TEXTS: Readonly<Record<number, string>> = {
  105: 'Your authentication has expired. Please sign in again.',
  110: 'You have reached the daily usage limit. Please try again later.',
  112: 'Your personal Credits have been exhausted. Please check your plan.',
  113: 'The usage limit has been reached. Please check your quota and try again later.',
  114: 'The free trial account limit has been reached. Please check your plan.',
  115: 'The free plan usage limit has been reached. Please check your plan.',
  116: 'Your team Credits have been exhausted. Please contact your administrator.',
  117: 'Your team member Credits limit has been reached. Please contact your administrator.',
  118: 'Your personal Credits have been exhausted. Please check your plan.',
  119: 'The free usage limit for this model has been reached. Please select another model or check your plan.',
  122: 'Your Billing Group has reached its Credits limit for this billing cycle. Please contact admin to continue.',
  130: 'Your Credits have been exhausted. Please check your plan or contact your administrator.',
  80411:
    'The input is too long for this model. Please shorten it or start a new conversation.',
  80412:
    'There are too many images or documents. Please reduce the number of attachments.',
  10605:
    'The model is busy and could not complete the request. Please try again later.',
};

export function getQoderErrorText(
  code: number | string | undefined,
): string | undefined {
  return QODER_ERROR_TEXTS[Number(code)];
}
