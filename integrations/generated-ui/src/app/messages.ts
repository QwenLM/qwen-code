/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Text for the trusted card frame. The host's locale selects the catalog;
// generated content and messages sent to the session are not translated.
const EN = {
  'title.placeholder': 'Interactive view',
  'view.label': 'Generated interactive content',
  stop: 'Stop',
  showMore: 'Show more',
  showLess: 'Show less',
  'status.waiting': 'Waiting for the completed view…',
  'status.starting': 'Starting the interactive view…',
  'status.running': 'Updating the view…',
  'status.ready': 'Latest update applied',
  'status.dirty': 'Parameters changed. Apply them in the view.',
  'status.stopped': 'Stopped',
  'status.error': 'The view runtime failed. Use the summary.',
  'stopped.title': 'This view is stopped.',
  'stopped.body': 'Reopen the view to start again from its initial values.',
  'notice.superseded':
    'An older update was skipped. Your newer inputs were kept.',
  'notice.outdated': 'The displayed update may still use earlier parameters.',
  'notice.queue':
    'Some interactions were not processed because the queue was full. Wait for the update, then repeat the intended action.',
  'notice.local':
    'Changes stay in this page. Refreshing the page restarts from the initial values.',
  'continue.label': 'Continue analysis with current parameters',
  'continue.again': 'Review again after checking the session',
  'continue.fix': 'Ask the assistant to fix this view',
  'help.unavailable':
    'Continuing analysis requires a connected Qwen Code host with message review. Local interactions remain available.',
  'help.fix':
    'Review a message with this error before sending it to this session. The assistant can then show a corrected view.',
  'help.continue':
    'Sends the applied values to this session to continue the analysis.',
  'help.continueChat':
    'Sends the applied values to this session. You can also just keep chatting: after you change values, they are attached to your next message.',
  'continuation.notReady':
    'Parameters are not ready. Wait for the view’s update, then apply any changed parameters before sending.',
  'continuation.tooLarge':
    'The complete parameter message exceeds 16 KiB. Reduce parameter content and apply the update before sending. Nothing was sent for this attempt.',
  'continuation.waiting':
    'Sending the applied values to the session… Later edits do not change this message.',
  'continuation.waitingFix':
    'Waiting for session confirmation… Review the message in the host.',
  'continuation.accepted':
    'The session accepted the request. Analysis may still be running; follow it in the original session.',
  'continuation.notSent': 'Not sent.',
  'continuation.notSentEarlier':
    'Not sent. An earlier request may still be in flight; check the original session before reviewing again.',
  'continuation.expired': 'The review timed out. Nothing was sent.',
  'continuation.unconfirmed':
    'Acceptance could not be confirmed. The request may still be in flight. Check the original session before reviewing again; another submission could duplicate a request. Nothing is retried automatically.',
  'continuation.stopped':
    'Stopped waiting for confirmation. Check the original session; a request already sent may still be accepted. Stopping this card does not withdraw a session request.',
} as const;

export type MessageKey = keyof typeof EN;

const ZH_CN: Record<MessageKey, string> = {
  'title.placeholder': '交互视图',
  'view.label': '生成的交互内容',
  stop: '停止',
  showMore: '展开',
  showLess: '收起',
  'status.waiting': '正在等待完整视图…',
  'status.starting': '正在启动交互视图…',
  'status.running': '正在更新视图…',
  'status.ready': '已应用最新更新',
  'status.dirty': '参数已修改，请在视图中应用。',
  'status.stopped': '已停止',
  'status.error': '视图运行失败，请参考摘要。',
  'stopped.title': '此视图已停止。',
  'stopped.body': '重新打开视图即可从初始参数重新开始。',
  'notice.superseded': '已跳过一次较早的更新，保留了你较新的输入。',
  'notice.outdated': '当前显示的结果可能仍基于之前的参数。',
  'notice.queue': '队列已满，部分操作未被处理。请等待更新完成后重新操作。',
  'notice.local': '修改只保存在当前页面，刷新页面后会恢复初始参数。',
  'continue.label': '用当前参数继续分析',
  'continue.again': '确认会话状态后重新审阅',
  'continue.fix': '请助手修复此视图',
  'help.unavailable':
    '继续分析需要连接到支持消息审阅的 Qwen Code 宿主。本地交互仍然可用。',
  'help.fix':
    '发送前会先让你审阅包含此错误的消息，助手随后可以展示修正后的视图。',
  'help.continue': '把已应用的参数发送到此会话继续分析。',
  'help.continueChat':
    '把已应用的参数发送到此会话。也可以直接继续聊天：修改参数后，最新参数会附带在你的下一条消息里。',
  'continuation.notReady':
    '参数尚未就绪。请等待视图更新，并应用修改后的参数后再发送。',
  'continuation.tooLarge':
    '完整参数消息超过 16 KiB。请减少参数内容并应用更新后再发送。本次没有发送任何内容。',
  'continuation.waiting':
    '正在把已应用的参数发送到会话… 之后的修改不会改变这条消息。',
  'continuation.waitingFix': '正在等待会话确认… 请在宿主中审阅消息。',
  'continuation.accepted':
    '会话已接受请求，分析可能仍在进行，请在原会话中查看。',
  'continuation.notSent': '未发送。',
  'continuation.notSentEarlier':
    '未发送。之前的请求可能仍在处理中，请先查看原会话再重新审阅。',
  'continuation.expired': '审阅已超时，没有发送任何内容。',
  'continuation.unconfirmed':
    '无法确认是否已被接受，请求可能仍在处理中。请先查看原会话再重新审阅，重复提交可能产生重复请求。不会自动重试。',
  'continuation.stopped':
    '已停止等待确认。请查看原会话：已经发出的请求仍可能被接受，停止此卡片不会撤回会话请求。',
};

// Failures the frame itself reports. Errors from the generated document
// (script errors, rejected markup) are shown as written.
const ZH_CN_ERRORS: Record<string, string> = {
  'The interactive host is unavailable. Use the summary.':
    '交互宿主不可用，请参考摘要。',
  'This browser cannot run the view. Use the summary.':
    '此浏览器无法运行该视图，请参考摘要。',
  'This browser cannot display the view.': '此浏览器无法显示该视图。',
  'This card changed unexpectedly. Open a new view.':
    '此卡片发生了意外变化，请打开新的视图。',
  'The generated view returned an invalid update.':
    '生成的视图返回了无效的更新。',
  'The view runtime failed. The summary is still available.':
    '视图运行失败，摘要仍然可用。',
  'The saved view is invalid or unsupported.': '保存的视图无效或不受支持。',
  'The view could not read its current inputs.': '视图无法读取当前输入。',
  'The view runtime could not receive an interaction.':
    '视图运行时无法接收交互。',
  'The view exceeded its execution time limit.': '视图超出了执行时间限制。',
  'The view exceeded its input limit.': '视图超出了输入限制。',
};

export interface Translate {
  (key: MessageKey): string;
  /** The frame's own failures in the host locale; other errors unchanged. */
  error(message: string): string;
}

export function translator(locale: string | undefined): Translate {
  const zh = /^zh(-|$)/i.test(locale ?? '');
  const catalog: Record<MessageKey, string> = zh ? ZH_CN : EN;
  const translate = (key: MessageKey) => catalog[key];
  translate.error = (message: string) =>
    (zh && Object.hasOwn(ZH_CN_ERRORS, message)
      ? ZH_CN_ERRORS[message]
      : undefined) ?? message;
  return translate;
}
