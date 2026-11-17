/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export type ProactiveRepairKind = 'mutation' | 'cancel';

const PROACTIVE_PROMISE =
  /(?:(?:我会|我来|我帮你|我就|到时我)|(?:奴才|小的|本助手|小助手|这边).{0,8}(?:会|来|帮你|帮您|就|马上|立马|立刻|及时)).{0,24}(?:看着|盯着|听着|监听|监测|监控|监督|提醒|通知|叫|纠正|警告)/iu;

const PROACTIVE_CANCEL_CLAIM =
  /(?:已(?:经)?|成功|刚刚)(?:为你)?(?:停止|取消|关闭|删除|结束).{0,18}(?:描述|解说|监控|监测|观察|监听|提醒|任务)|(?:描述|解说|监控|监测|观察|监听|提醒|任务).{0,12}(?:已(?:经)?(?:停止|取消|关闭|删除|结束)(?:了|完成)?|(?:成功)?(?:停止|取消|关闭|删除|结束)(?:了|完成))|(?:好的|好|可以).{0,8}(?:停止|取消|关闭|删除|结束).{0,18}(?:描述|解说|监控|监测|观察|监听|提醒|任务)/iu;

const NEGATIVE_PROMISE = /不能|不会|无法|没有成功|没能/u;
const NEGATIVE_CANCEL = /不能|无法|没有成功|没能|未能|尚未|还没/u;

export const PROACTIVE_MUTATION_REPAIR_INSTRUCTION =
  '请重新检查紧邻的真实麦克风请求。你刚才承诺了回复结束后仍需继续' +
  '进行的提醒或观察，却没有创建相应任务。请由你自己重新判断原始音频' +
  '意图，现在只调用一个匹配的提醒工具；不要输出文字，也不要口头承诺。';

export const PROACTIVE_CANCEL_REPAIR_INSTRUCTION =
  '请重新检查紧邻的真实麦克风请求。你刚才声称已经停止或取消了一个' +
  'Proactive任务，却没有执行停止操作。请由你自己重新判断原始音频意图，' +
  '现在只调用cancel_proactive_task；不要输出文字，也不要声称已经停止。';

/** Inspect only the assistant's own final transcript, never user ASR. */
export function detectProactiveRepairIntent(
  assistantTranscript: unknown,
): ProactiveRepairKind | undefined {
  if (typeof assistantTranscript !== 'string') return undefined;
  if (
    PROACTIVE_CANCEL_CLAIM.test(assistantTranscript) &&
    !NEGATIVE_CANCEL.test(assistantTranscript)
  ) {
    return 'cancel';
  }
  if (
    PROACTIVE_PROMISE.test(assistantTranscript) &&
    !NEGATIVE_PROMISE.test(assistantTranscript)
  ) {
    return 'mutation';
  }
  return undefined;
}
