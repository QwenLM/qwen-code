import { describe, expect, it, vi } from 'vitest';
import { formatSubscriptionQuotaDisplay } from '@qwen-code/qwen-code-core/utils/subscription-quota.js';
import {
  WEB_SHELL_LANGUAGES,
  getTranslator,
  languageLabel,
  languageSettingToWebShellLanguage,
  normalizeLanguage,
} from './i18n';
import type { WebShellLanguage } from './i18n';

// getTranslator returns the raw key when EN has no entry. SettingsMessage
// translateSettingText then substitutes the settingsSchema.ts description,
// which still says Enter accepts into the input buffer — wrong in Web Shell,
// where Enter accepts and submits (#9521). A missing EN override is therefore
// silent in the UI and in tests unless the catalog itself is pinned.
const FOLLOWUP_SETTING_KEYS = [
  'settings.label.ui.enableFollowupSuggestions',
  'settings.description.ui.enableFollowupSuggestions',
] as const;

// The panel's localization cases compare rendered text against the same
// translator lookup the component performs, so a missing zh entry falls back
// to EN on both sides and they stay green. Parity has to be asserted here,
// key by key, including the strings no panel case renders.
const WEIXIN_LOGIN_KEYS = [
  'title',
  'description',
  'loggedIn',
  'loggedOut',
  'login',
  'relogin',
  'logout',
  'refresh',
  'waiting',
  'preparing',
  'scanned',
  'ready',
  'expired',
  'error',
  'credentialsError',
  'unsupported',
  'restartHint',
  'userId',
  'savedAt',
  'qrAlt',
  'openUrl',
].map((suffix) => `channels.weixin.${suffix}`);

const BROWSER_NOTIFICATION_KEYS = [
  'label',
  'description',
  'prompt',
  'reply',
  'completed',
  'failed',
  'ended',
  'approval',
  'question',
  'allow',
  'enable',
  'helpEnabled',
  'helpWaiting',
  'helpWhen',
  'helpSystem',
  'helpMac',
  'helpWindows',
  'enabled',
  'disabled',
  'waiting',
  'denied',
  'unavailable',
  'requesting',
  'error',
  'temporary',
].map((suffix) => `browserNotifications.${suffix}`);

const SCHEDULED_TASK_DELIVERY_KEYS = [
  'channel',
  'off',
  'hint',
  'unavailable',
  'discardChanges',
  'perRun',
  'required',
  'whitespace',
  'trimWhitespace',
  'loading',
  'loadingContacts',
  'channelsFailed',
  'noChannels',
  'targetUnavailable',
  'notObserved',
  'suggestion',
  'manual',
  'contactsFailed',
  'suggestionsHint',
  'type',
  'id',
  'user',
  'chat',
  'cardPrefix',
].map((suffix) => `scheduledTasks.delivery.${suffix}`);

describe('web-shell i18n catalog', () => {
  it('localizes the scheduled-task workspace host-lock hint', () => {
    expect(getTranslator('en')('scheduledTasks.workspaceFixedByHost')).toBe(
      'Fixed by host',
    );
    expect(getTranslator('zh-CN')('scheduledTasks.workspaceFixedByHost')).toBe(
      '由宿主固定',
    );
  });

  it('keeps every scheduled-task delivery translation in both locales', () => {
    const en = getTranslator('en');
    const zh = getTranslator('zh-CN');
    for (const key of SCHEDULED_TASK_DELIVERY_KEYS) {
      expect(en(key)).not.toBe(key);
      expect(zh(key)).not.toBe(key);
      expect(zh(key)).not.toBe(en(key));
    }
    expect(zh('scheduledTasks.delivery.perRun')).toContain(
      '每次新会话不支持频道投递',
    );
  });

  it('keeps the channel range message spacing in both locales', () => {
    const en = getTranslator('en');
    const zh = getTranslator('zh-CN');
    const key = 'channels.editor.validation.outOfRange';

    // The exclusive-floor shapes predate the inclusive bound. Folding the
    // lower clause into one variable moved a space inside the interpolation
    // and silently changed these two existing zh strings; pin them verbatim.
    expect(zh(key, { min: 0, max: 86_400_000 })).toBe(
      '请输入大于 0 且不超过 86400000 的数字。',
    );
    expect(zh(key, { min: 0 })).toBe('请输入大于 0 的数字。');
    expect(zh(key, { max: 4 })).toBe('请输入不超过 4 的数字。');
    expect(en(key, { min: 0, max: 86_400_000 })).toBe(
      'Enter a number greater than 0 and at most 86400000.',
    );

    // The inclusive floor is worded differently but padded the same way.
    expect(zh(key, { minInclusive: 0, max: 5000 })).toBe(
      '请输入不小于 0 且不超过 5000 的数字。',
    );
    expect(zh(key, { minInclusive: 0 })).toBe('请输入不小于 0 的数字。');
    expect(en(key, { minInclusive: 0, max: 5000 })).toBe(
      'Enter a number at least 0 and at most 5000.',
    );
  });

  it('keeps every WeChat login translation in both locales', () => {
    const en = getTranslator('en');
    const zh = getTranslator('zh-CN');
    for (const key of WEIXIN_LOGIN_KEYS) {
      const vars = { id: 'wx-user-1', time: '2026-11-09 10:00' };
      expect(en(key, vars)).not.toBe(key);
      expect(zh(key, vars)).not.toBe(key);
      // zh against en, not zh against the key: the translator falls back to
      // EN per key, so a deleted zh entry would otherwise pass both checks.
      expect(zh(key, vars)).not.toBe(en(key, vars));
    }
  });

  it('keeps every browser notification translation in both locales', () => {
    const en = getTranslator('en');
    const zh = getTranslator('zh-CN');
    for (const key of BROWSER_NOTIFICATION_KEYS) {
      const english = en(key, { text: 'Task' });
      const chinese = zh(key, { text: 'Task' });
      expect(english).not.toBe(key);
      expect(chinese).not.toBe(key);
      expect(chinese).not.toBe(english);
    }
    expect(en('browserNotifications.prompt', { text: 'Task' })).toBe(
      'Prompt: Task',
    );
    expect(zh('browserNotifications.reply', { text: 'Task' })).toBe(
      '回复：Task',
    );
  });

  it.each([
    [
      'en',
      "You've used up your weekly credits. Your credits are expected to reset in 2 days and 1 hour. Please try again after the reset.",
    ],
    ['zh-CN', '周额度已用完，预计将于2天 1小时后恢复，请在额度恢复后重试。'],
    [
      'ru',
      "You've used up your weekly credits. Your credits are expected to reset in 2 days and 1 hour. Please try again after the reset.",
    ],
  ] as const)(
    'formats quota data through the %s catalog',
    (language, expected) => {
      const now = Date.parse('2026-11-04T00:00:00Z');
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        expect(
          formatSubscriptionQuotaDisplay(
            {
              type: 'subscription_quota',
              memberType: 'pro',
              resetAt: now / 1000 + 49 * 3600,
            },
            getTranslator(language),
          ),
        ).toBe(expected);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('explains missing rewind identities in both locales', () => {
    expect(getTranslator('en')('rewind.identityUnavailable')).toContain(
      'no prompt identity',
    );
    expect(getTranslator('zh-CN')('rewind.identityUnavailable')).toContain(
      '身份',
    );
  });

  it('pluralizes deletion counts and explains unsupported sessions in both locales', () => {
    const en = getTranslator('en');
    expect(en('messageDelete.selected', { count: 1 })).toBe('1 group selected');
    expect(en('messageDelete.selected', { count: 2 })).toBe(
      '2 groups selected',
    );
    expect(en('messageDelete.confirmTitle', { count: 1 })).toBe(
      'Delete 1 message group?',
    );
    expect(en('messageDelete.confirmTitle', { count: 2 })).toBe(
      'Delete 2 message groups?',
    );
    expect(en('messageDelete.unsupported')).toBe(
      'Deleting saved messages is not supported for this session.',
    );
    expect(getTranslator('zh-CN')('messageDelete.unsupported')).toBe(
      '此会话不支持删除已保存的消息。',
    );
    expect(getTranslator('zh-CN')('messageDelete.selected', { count: 2 })).toBe(
      '已选 2 组',
    );
  });

  it('keeps the waiting minigame copy available in both locales', () => {
    for (const language of ['en', 'zh-CN'] as const) {
      const t = getTranslator(language);
      for (const key of [
        'waitingGame.title',
        'waitingGame.openActivity',
        'waitingGame.activityTitle',
        'waitingGame.usageTitle',
        'waitingGame.startGame',
        'waitingGame.backToHeatmap',
        'waitingGame.heatmap',
        'waitingGame.tokens',
        'waitingGame.jumpToMessage',
        'waitingGame.tokenTotal',
        'waitingGame.tokenInput',
        'waitingGame.tokenOutput',
        'waitingGame.tokenCached',
        'waitingGame.tokenContext',
        'waitingGame.tokenEmpty',
        'waitingGame.snakeControls',
        'waitingGame.collapse',
        'waitingGame.region',
        'waitingGame.controls',
        'waitingGame.paused',
        'waitingGame.pausedHint',
        'waitingGame.gameOver',
        'waitingGame.restart',
        'waitingGame.mute',
        'waitingGame.unmute',
      ]) {
        expect(t(key)).not.toBe(key);
      }
    }
    const zh = getTranslator('zh-CN');
    expect(zh('waitingGame.heatmap')).toBe('热力图');
    expect(zh('waitingGame.activityTitle')).toBe('问答热度');
    expect(zh('waitingGame.openActivity')).toBe('打开任务热度');
    expect(zh('waitingGame.score', { score: 100 })).toBe('得分 100');
    expect(zh('waitingGame.cleared', { count: 2, score: 100 })).toBe(
      '消除 2 列 · +100',
    );
  });

  it('keeps task cancellation and elapsed-time copy available in both locales', () => {
    const en = getTranslator('en');
    const zh = getTranslator('zh-CN');
    expect(en('managed.tasks.title')).toBe('Session tasks');
    expect(zh('managed.tasks.title')).toBe('会话任务');
    expect(en('managed.tasks.cancel.stopping')).toBe(
      'Stop requested. Waiting for the task to end.',
    );
    expect(zh('managed.tasks.cancel.stopping')).toBe(
      '停止请求已送达，等待任务结束。',
    );
    expect(en('managed.tasks.seconds', { seconds: 12 })).toBe('12 seconds');
    expect(zh('managed.tasks.seconds', { seconds: 12 })).toBe('12 秒');
  });

  it('keeps filter translations available and pluralizes record counts', () => {
    const en = getTranslator('en');
    expect(en('trajectory.filter.search')).toBe('Search loaded records…');
    expect(getTranslator('zh-CN')('trajectory.filter.search')).toBe(
      '搜索已加载记录…',
    );
    expect(en('trajectory.filter.count', { count: 1 })).toBe('1 match');
    expect(en('trajectory.filter.count', { count: 2 })).toBe('2 matches');
    expect(en('trajectory.filter.truncated', { count: 1 })).toContain(
      '(1 record)',
    );
    expect(en('trajectory.filter.truncated', { count: 2 })).toContain(
      '(2 records)',
    );
  });
  it('keeps the follow-up suggestion setting copy overridden in EN', () => {
    const t = getTranslator('en');
    for (const key of FOLLOWUP_SETTING_KEYS) {
      expect(t(key)).not.toBe(key);
    }
  });

  // The daemon validates a saved voice only while Live Voice is on; the copy
  // must not promise an unconditional check, in either locale.
  it('states the provider-validation condition on the voice hint', () => {
    expect(getTranslator('en')('settings.liveSetup.voiceHint')).toContain(
      'when Live Voice is on',
    );
    expect(getTranslator('zh-CN')('settings.liveSetup.voiceHint')).toContain(
      '开启 Live Voice 时',
    );
  });

  it('carries the next-call hint in both locales', () => {
    // Content assertions, not just presence: a missing zh-CN entry falls
    // back to the EN copy, which a not-the-key check cannot catch.
    expect(getTranslator('en')('settings.liveSetup.appliesNextCall')).toContain(
      'next call',
    );
    expect(
      getTranslator('zh-CN')('settings.liveSetup.appliesNextCall'),
    ).toContain('下一次通话');
  });

  // The model hint points at the picker's custom entry by name; keep the two
  // strings in step in both locales.
  it('names the custom model entry in the model hint', () => {
    for (const language of ['en', 'zh-CN'] as const) {
      const t = getTranslator(language);
      expect(t('settings.liveSetup.modelHint')).toContain(
        t('settings.liveSetup.modelCustom'),
      );
    }
  });

  // A locale outside the shipped union (the provider is typed, but the
  // runtime value is not checked) must resolve from the EN table: content
  // assertions, so a mutation of the EN entry itself is caught.
  it('falls back to EN for a language outside the shipped union', () => {
    const t = getTranslator('fr' as unknown as WebShellLanguage);
    expect(t('managed.tasks.title')).toBe('Session tasks');
    expect(t('trajectory.filter.search')).toBe('Search loaded records…');
    expect(t('messageDelete.selected', { count: 2 })).toBe('2 groups selected');
    expect(t('welcome.prompt')).not.toBe('welcome.prompt');
  });
});

// #13391: ru ships a PARTIAL catalog covering the Goal card and the Goals
// dialog only; every other key must fall back to EN in getTranslator. These
// pins guard the normalizer branches, the pluralisation and that fallback.
describe('web-shell ru locale', () => {
  it('normalizes ru spellings to ru and leaves the en/zh mappings untouched', () => {
    for (const value of [
      'ru',
      'ru-ru',
      'ru_ru',
      'russian',
      'русский',
      'RU',
      ' RU-RU ',
      // Region-qualified Russian must not fall through to en.
      'ru-UA',
      'ru-KZ',
      'ru-BY',
      'ru-MD',
    ]) {
      expect(normalizeLanguage(value)).toBe('ru');
    }
    expect(normalizeLanguage('en')).toBe('en');
    expect(normalizeLanguage('EN-US')).toBe('en');
    expect(normalizeLanguage('zh')).toBe('zh-CN');
    expect(normalizeLanguage('zh-cn')).toBe('zh-CN');
    expect(normalizeLanguage('zh_cn')).toBe('zh-CN');
    // Unrelated locales still collapse to en (fr, ja, … are not shipped).
    expect(normalizeLanguage('fr-FR')).toBe('en');
    expect(normalizeLanguage('ja-JP')).toBe('en');
    expect(normalizeLanguage(undefined)).toBe('en');
  });

  it('maps daemon language settings to ru, underscore and region forms included', () => {
    for (const value of [
      'ru',
      'ru-ru',
      'ru_ru',
      'russian',
      'русский',
      'RU',
      'ru-UA',
    ]) {
      expect(languageSettingToWebShellLanguage(value)).toBe('ru');
    }
    expect(languageSettingToWebShellLanguage('zh')).toBe('zh-CN');
    expect(languageSettingToWebShellLanguage('en')).toBe('en');
    expect(languageSettingToWebShellLanguage('fr')).toBeUndefined();
  });

  it('lists ru in the picker with the "Русский [ru]" label', () => {
    expect(WEB_SHELL_LANGUAGES).toEqual(['en', 'zh-CN', 'ru']);
    expect(languageLabel('ru')).toBe('Русский [ru]');
  });

  it('lists every shipped language in the /language error and usage copy', () => {
    // The /language gate, help and completions derive from WEB_SHELL_LANGUAGES;
    // the error/usage copy must carry the same set, in both locales.
    for (const language of ['en', 'zh-CN'] as const) {
      const t = getTranslator(language);
      expect(t('language.invalid')).toContain('en, zh-CN, ru');
      expect(t('language.usage')).toContain('en|zh-CN|ru');
      expect(t('language.usage')).toContain('[--project|--global]');
    }
  });

  it('pluralises turn counters the Russian way', () => {
    const t = getTranslator('ru');
    expect(t('goal.turns', { count: 1 })).toBe('1 ход');
    expect(t('goal.turns', { count: 2 })).toBe('2 хода');
    expect(t('goal.turns', { count: 5 })).toBe('5 ходов');
    expect(t('goal.turns', { count: 11 })).toBe('11 ходов');
    expect(t('goal.turns', { count: 21 })).toBe('21 ход');
    // The budget side pluralises on the budget, not the used count.
    expect(t('goal.turnsOfBudget', { count: 1, budget: 1 })).toBe('1 / 1 ход');
    expect(t('goal.turnsOfBudget', { count: 1, budget: 2 })).toBe('1 / 2 хода');
    expect(t('goal.turnsOfBudget', { count: 3, budget: 11 })).toBe(
      '3 / 11 ходов',
    );
  });

  it('pluralises token spend the Russian way', () => {
    const t = getTranslator('ru');
    expect(t('goal.tokens', { used: 1 })).toBe('1 токен');
    expect(t('goal.tokens', { used: 3 })).toBe('3 токена');
    expect(t('goal.tokens', { used: 5 })).toBe('5 токенов');
    expect(t('goal.tokens', { used: 11 })).toBe('11 токенов');
    expect(t('goal.tokens', { used: 21 })).toBe('21 токен');
  });

  it('pluralises the token budget on the budget, not the used count', () => {
    const t = getTranslator('ru');
    // Plain numbers: production's abbreviated shape (>= 1000 → '1.2k')
    // coerces to NaN on both arms and would test the coercion, not the
    // operand.
    expect(t('goal.tokensOfBudget', { used: 1, budget: 2 })).toBe(
      '1 / 2 токена',
    );
    expect(t('goal.tokensOfBudget', { used: 3, budget: 11 })).toBe(
      '3 / 11 токенов',
    );
  });

  it('pluralises the goals counter the Russian way', () => {
    const t = getTranslator('ru');
    expect(t('goals.count', { count: 1 })).toBe('1 активная цель');
    expect(t('goals.count', { count: 2 })).toBe('2 активные цели');
    expect(t('goals.count', { count: 5 })).toBe('5 активных целей');
    expect(t('goals.count', { count: 11 })).toBe('11 активных целей');
    expect(t('goals.count', { count: 21 })).toBe('21 активная цель');
  });

  it('renders goals.dropped with the session count and the right plural', () => {
    const t = getTranslator('ru');
    expect(t('goals.dropped', { count: 3 })).toBe(
      'не удалось связаться с 3 сессиями — цели, которые они выполняли, отсутствуют в этом списке.',
    );
    expect(t('goals.dropped', { count: 5 })).toBe(
      'не удалось связаться с 5 сессиями — цели, которые они выполняли, отсутствуют в этом списке.',
    );
    expect(t('goals.dropped', { count: 1 })).toBe(
      'не удалось связаться с 1 сессией — цели, которые они выполняли, отсутствуют в этом списке.',
    );
    // 21 ends in 1: the one-form (instrumental singular) must apply.
    expect(t('goals.dropped', { count: 21 })).toBe(
      'не удалось связаться с 21 сессией — цели, которые они выполняли, отсутствуют в этом списке.',
    );
  });

  it('renders the Goal card from the ru catalog, not from EN', () => {
    const t = getTranslator('ru');
    const en = getTranslator('en');
    expect(t('goal.blocked')).toBe('Цель заблокирована');
    expect(t('goal.lastCheck')).toBe('Последняя проверка');
    expect(t('goal.status.blocked')).toBe('Заблокирована');
    expect(t('goals.title')).toBe('Цели');
    expect(t('goals.empty')).toBe(
      'Нет активных целей. Задайте: /goal <условие>.',
    );
    expect(t('goal.blocked')).not.toBe(en('goal.blocked'));
  });

  it('falls back to EN for keys the partial ru catalog lacks', () => {
    const t = getTranslator('ru');
    const en = getTranslator('en');
    // Plain and parameterised EN values both resolve, not the raw key.
    expect(t('welcome.prompt')).toBe(en('welcome.prompt'));
    expect(t('welcome.prompt')).not.toBe('welcome.prompt');
    expect(t('capacityChoice.capacity', { used: 1, limit: 2 })).toBe(
      en('capacityChoice.capacity', { used: 1, limit: 2 }),
    );
    // Unknown in every catalog: the key itself, as in all locales.
    expect(t('no.such.key')).toBe('no.such.key');
  });
});
