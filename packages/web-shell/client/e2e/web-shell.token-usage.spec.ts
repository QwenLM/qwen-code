import { expect, test, type Locator } from '@playwright/test';
import type { DaemonSessionStatsStatus } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

for (const { width, language, theme } of [
  { width: 1200, language: 'en', theme: 'light' },
  { width: 1200, language: 'zh-CN', theme: 'light' },
  { width: 1200, language: 'en', theme: 'dark' },
  { width: 390, language: 'en', theme: 'light' },
  { width: 390, language: 'zh-CN', theme: 'light' },
  { width: 390, language: 'zh-CN', theme: 'dark' },
]) {
  test.describe(`token usage ${width}px ${language} ${theme}`, () => {
    test.use({ hasTouch: width === 390, timezoneId: 'UTC' });
    test(`token usage disclosure ${width}px ${language} ${theme} @smoke`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 960 });
      await page.clock.setFixedTime(new Date('2026-10-20T11:49:29Z'));
      await page.addInitScript(
        ({ language, theme }) => {
          localStorage.setItem('qwen-code-web-shell-language', language);
          localStorage.setItem('qwen-code-web-shell-theme', theme);
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'hidden',
          });
        },
        { language, theme },
      );
      const scenario = createWebShellDaemonScenario();
      const daemon = await installMockDaemon(page, scenario, {
        baseURL: String(testInfo.project.use.baseURL),
      });
      const metrics = (prompt: number, candidates: number, cached: number) => ({
        api: { totalRequests: 105, totalErrors: 0, totalLatencyMs: 2404500 },
        tokens: {
          prompt,
          candidates,
          total: prompt + candidates,
          cached,
          thoughts: Math.floor(candidates / 2),
        },
      });
      const stats: DaemonSessionStatsStatus = {
        v: 1,
        sessionId: scenario.sessionId,
        workspaceCwd: scenario.workspaceCwd,
        sessionStartTimeMs: 1000,
        durationMs: 42000,
        promptCount: 2,
        models: {
          'qwen3.8-flash': {
            ...metrics(14000000, 250000, 12320000),
            generation: {
              timedRequests: 4,
              totalTtftMs: 4800,
              totalGenerationDurationMs: 2000,
              totalThroughputOutputTokens: 898,
            },
          },
          'qwen3.8-max-0902': metrics(3000000, 750000, 2700000),
          'gpt-6.1-sol': metrics(500000, 100000, 490000),
          'gpt-5.6-sol': metrics(300000, 100000, 294000),
          'bailian/kimi-k3-with-a-very-long-model-name-for-layout': metrics(
            900000,
            90000,
            720000,
          ),
        },
        tools: {
          totalCalls: 0,
          totalSuccess: 0,
          totalFail: 0,
          totalDurationMs: 0,
          byName: {},
        },
        files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
        sources: [
          {
            id: 'invocation-extractor-one',
            type: 'general-purpose',
            name: 'Review tests e2e and docs',
            tokens: metrics(500000, 5000, 350000).tokens,
          },
          {
            id: 'invocation-extractor-two',
            type: 'managed-auto-memory-extractor',
            name: 'managed-auto-memory-extractor',
            tokens: metrics(250000, 2500, 200000).tokens,
          },
          {
            id: 'invocation-dreamer-one',
            type: 'managed-auto-memory-dreamer',
            name: 'managed-auto-memory-dreamer',
            tokens: metrics(100000, 1000, 80000).tokens,
          },
        ],
      };
      let reads = 0;
      await page.route('**/session/*/stats', (route) => {
        reads++;
        return route.fulfill({ json: stats });
      });
      await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
      const connection = await daemon.sse.waitForConnection(scenario.sessionId);
      await daemon.sendEvent(
        replayCompleteEvent({
          sessionId: connection.sessionId,
          replayedCount: 0,
        }),
      );
      const zh = language === 'zh-CN';
      await page
        .getByRole('button', {
          name: zh ? '会话 Token 消耗' : 'Session token usage',
          exact: true,
        })
        .click();
      const hero = page.getByText(zh ? '总 Token' : 'Total tokens', {
        exact: true,
      });
      await expect(hero).toBeVisible();
      const panel = page.getByTestId('token-usage-panel');
      await expect(panel.locator('dl').first().locator('dt')).toHaveCount(2);
      const model = panel.locator('[data-color]').filter({
        has: page.locator('[title="qwen3.8-flash"]'),
      });
      await expect(model).toContainText('71.3%');
      const timing = zh
        ? [
            ['首 token', '1.2s'],
            ['输出速度', '449.0 tok/s'],
            ['生成', '500ms'],
            ['请求', '105'],
            ['平均延迟', '22.9s'],
          ]
        : [
            ['First token', '1.2s'],
            ['Output speed', '449.0 tok/s'],
            ['Generation', '500ms'],
            ['Requests', '105'],
            ['Avg latency', '22.9s'],
          ];
      const timingText = timing.flat().join('');
      const modelText = (input: string, rate: string, share: string) =>
        `qwen3.8-flash${timingText}${zh ? '输入' : 'Input'}${zh ? `${input}（缓存率：${rate}%）` : `${input} (cache rate: ${rate}%)`}${zh ? '总输出' : 'Total output'}250K${share}%`;
      await expect(model).toHaveText(modelText('14M', '88.0', '71.3'));
      await expect(model.getByText('71.3%', { exact: true })).toBeVisible();
      await expect(model.locator('details, summary')).toHaveCount(0);
      const timingGrid = model.locator('dl').first();
      const tokenRow = model.locator('dl').nth(1);
      await expect(model.getByRole('button')).toHaveCount(0);
      await expect(timingGrid.locator('dt')).toHaveText(
        timing.map(([label]) => label),
      );
      await expect(timingGrid.locator('dd')).toHaveText(
        timing.map(([, value]) => value),
      );
      await expect(timingGrid).toHaveCSS('display', 'grid');
      const checkTimingOverflow = async () => {
        for (const text of await timingGrid.locator('dt, dd').all()) {
          await expect(text).toBeVisible();
          await expect(text).toHaveCSS('white-space', 'nowrap');
          const { clipped, tagName } = await text.evaluate((element) => ({
            clipped: element.scrollWidth > element.clientWidth,
            tagName: element.tagName,
          }));
          if (width === 390 && tagName === 'DD') {
            expect(clipped).toBe(false);
          }
          if (clipped) {
            await expect(text).toHaveAttribute(
              'title',
              (await text.textContent())!,
            );
          }
        }
      };
      await checkTimingOverflow();
      const otherModel = panel
        .locator('[data-color]')
        .filter({ has: page.locator('[title="qwen3.8-max-0902"]') });
      const otherTiming = otherModel.locator('dl').first().locator('dt');
      await expect(otherTiming).toHaveText(
        zh ? ['请求', '平均延迟'] : ['Requests', 'Avg latency'],
      );
      const timingPath = testInfo.outputPath('token-model-timing.png');
      await page.screenshot({ path: timingPath, animations: 'disabled' });
      await testInfo.attach('token-model-timing', {
        path: timingPath,
        contentType: 'image/png',
      });
      const checkContrast = async (
        target: Locator,
        property: 'color' | 'outlineColor',
        minimum = 3,
      ) => {
        const contrast = await target.evaluate((element, property) => {
          const context = document.createElement('canvas').getContext('2d')!;
          const rgba = (color: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            return Array.from(context.getImageData(0, 0, 1, 1).data);
          };
          let surface = element.parentElement;
          while (
            surface &&
            rgba(getComputedStyle(surface).backgroundColor)[3] === 0
          ) {
            surface = surface.parentElement;
          }
          if (!surface) throw new Error('Missing adjacent background');
          const luminance = (color: number[]) =>
            color.slice(0, 3).reduce((sum, channel, index) => {
              const value = channel / 255;
              const linear =
                value <= 0.04045
                  ? value / 12.92
                  : ((value + 0.055) / 1.055) ** 2.4;
              return sum + linear * [0.2126, 0.7152, 0.0722][index];
            }, 0);
          const foreground = luminance(
            rgba(getComputedStyle(element)[property]),
          );
          const background = luminance(
            rgba(getComputedStyle(surface).backgroundColor),
          );
          return (
            (Math.max(foreground, background) + 0.05) /
            (Math.min(foreground, background) + 0.05)
          );
        }, property);
        expect(contrast).toBeGreaterThanOrEqual(minimum);
      };
      for (const label of await timingGrid.locator('dt').all()) {
        await checkContrast(label, 'color', 4.5);
      }
      await checkContrast(hero, 'color', 4.5);
      for (const card of await panel.locator('[data-color]').all()) {
        await checkContrast(card.getByText(/^\d+\.\d+%$/), 'color', 4.5);
      }
      for (const label of await panel
        .locator('dl')
        .first()
        .locator('dt')
        .all()) {
        await checkContrast(label, 'color', 4.5);
      }
      const longName = panel.locator(
        '[title="bailian/kimi-k3-with-a-very-long-model-name-for-layout"]',
      );
      await expect(longName).toHaveCSS('white-space', 'nowrap');
      await expect(longName).toHaveCSS('text-overflow', 'ellipsis');
      expect(
        await longName.evaluate(
          (element) =>
            element.clientHeight <=
            parseFloat(getComputedStyle(element).lineHeight) + 1,
        ),
      ).toBe(true);

      expect(
        await tokenRow
          .locator(':scope > div')
          .nth(1)
          .evaluate((node) => getComputedStyle(node, '::before').content),
      ).toContain('·');
      await expect(tokenRow).toHaveCSS('column-gap', 'normal');
      await expect(tokenRow).toHaveCSS('row-gap', 'normal');
      await expect(
        model.getByText(zh ? '输入' : 'Input', { exact: true }),
      ).toBeVisible();
      await expect(
        model.getByText(zh ? '总输出' : 'Total output', { exact: true }),
      ).toBeVisible();
      await expect(tokenRow.locator('dt')).toHaveCount(2);
      await expect(tokenRow.locator('dd').first()).toHaveText(
        zh ? '14M（缓存率：88.0%）' : '14M (cache rate: 88.0%)',
      );
      await expect(model).not.toContainText(zh ? '思考' : 'Reasoning');
      await expect(model).not.toContainText('12.32M');
      const checkMetricTooltip = async (row: Locator, values: string[]) => {
        await expect(row).toHaveCSS('cursor', 'default');
        await expect(row).toHaveCSS('white-space', 'nowrap');
        await expect(row).toHaveCSS('text-overflow', 'ellipsis');
        await expect(row).toHaveAttribute('tabindex', '0');
        expect(
          await row.evaluate((element) => {
            const style = getComputedStyle(element);
            return element.clientHeight <= parseFloat(style.lineHeight) + 1;
          }),
        ).toBe(true);
        await row.hover();
        const popup = page.locator('[data-slot="tooltip-content"]');
        await expect(popup).toHaveAttribute('data-state', /open$/);
        await expect(popup).toHaveCSS('opacity', '1');
        const items = popup.locator(':scope > dl > div');
        await expect(items).toHaveCount(4);
        expect(await items.locator('dt').allTextContents()).toEqual(
          zh
            ? ['输入', '缓存', '总输出', '思考']
            : ['Input', 'Cache', 'Total output', 'Reasoning'],
        );
        expect(await items.locator('dd').allTextContents()).toEqual(values);
        const positions = await items.evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().top),
        );
        expect(
          positions.every(
            (y, index) => index === 0 || y > positions[index - 1],
          ),
        ).toBe(true);
        await page.mouse.move(0, 0);
        await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(
          0,
        );
        await row.focus();
        await expect(popup).toHaveAttribute('data-state', /open$/);
        await row.press('Escape');
        await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(
          0,
        );
        await row.blur();
        if (width === 390) {
          await row.tap();
          await expect(popup).toHaveAttribute('data-state', /open$/);
          await expect(popup).toHaveCSS('opacity', '1');
          const metricPath = testInfo.outputPath(
            `token-metrics-touch-${values[0]}.png`,
          );
          await page.screenshot({ path: metricPath, animations: 'disabled' });
          await expect(popup).toHaveAttribute('data-state', /open$/);
          await testInfo.attach('Complete metric rows after touch', {
            path: metricPath,
            contentType: 'image/png',
          });
          await hero.tap();
          await expect(
            page.locator('[data-slot="tooltip-content"]'),
          ).toHaveCount(0);
        }
      };
      await checkMetricTooltip(tokenRow, [
        '14M',
        zh ? '12.32M（88.0%）' : '12.32M (88.0%)',
        '250K',
        '125K',
      ]);
      const modelShareLabel = zh ? 'Token 占比：71.3%' : 'Token share: 71.3%';
      const modelTrack = model.getByRole('img', { name: modelShareLabel });
      await modelTrack.hover();
      await expect(page.getByRole('tooltip')).toHaveText(modelShareLabel);
      const otherTrack = otherModel.getByRole('img');
      await otherTrack.hover();
      const otherShareLabel = (await otherTrack.getAttribute('aria-label'))!;
      await expect(
        page.getByRole('tooltip', { name: otherShareLabel, exact: true }),
      ).toHaveText(otherShareLabel);
      await expect(otherTrack).toHaveAttribute('data-state', 'instant-open');
      await page.mouse.move(0, 0);
      await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(
        0,
      );
      await modelTrack.focus();
      await expect(page.getByRole('tooltip')).toHaveText(modelShareLabel);
      await modelTrack.press('Escape');
      await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(
        0,
      );
      await modelTrack.blur();
      if (width === 390) {
        await modelTrack.tap();
        const popup = page.locator('[data-slot="tooltip-content"]');
        await expect(popup).toHaveCSS('opacity', '1');
        await expect(page.getByRole('tooltip')).toHaveText(modelShareLabel);
        await expect(popup).toHaveCSS('pointer-events', 'none');
        await tokenRow.tap();
        await expect(popup.locator(':scope > dl > div > dt')).toHaveText(
          zh
            ? ['输入', '缓存', '总输出', '思考']
            : ['Input', 'Cache', 'Total output', 'Reasoning'],
        );
        await hero.tap();
        await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(
          0,
        );
      }

      const subagents = panel
        .locator('details')
        .filter({
          has: page.locator('summary h3', {
            hasText: zh ? '按agent' : 'By agent',
          }),
        })
        .first();
      await subagents.locator(':scope > summary').click();
      await expect(subagents.locator('[data-source-id]')).toHaveCount(3);
      await expect(subagents.locator('details')).toHaveCount(0);
      const mainAgent = subagents.locator('[data-main-agent]');
      await expect(
        mainAgent.getByText(zh ? '主Agent' : 'Main Agent', { exact: true }),
      ).toBeVisible();
      expect(
        await mainAgent.evaluate(
          (element) => element.parentElement?.firstElementChild === element,
        ),
      ).toBe(true);
      await expect(mainAgent).toContainText('95.7%');
      await expect(mainAgent.locator('dd').first()).toHaveText(
        zh ? '17.85M（缓存率：89.0%）' : '17.85M (cache rate: 89.0%)',
      );
      await expect(mainAgent.locator('dd').last()).toHaveText('1.28M');
      await checkMetricTooltip(mainAgent.locator('dl'), [
        '17.85M',
        zh ? '15.89M（89.0%）' : '15.89M (89.0%)',
        '1.28M',
        '640.8K',
      ]);
      await expect(panel.locator('[data-color="4"]')).toHaveCount(1);
      await expect(
        panel.getByText(zh ? '输入' : 'Input', { exact: true }).first(),
      ).toBeVisible();
      await expect(
        panel
          .locator('dd span')
          .filter({ hasText: zh ? '缓存' : 'Cache' })
          .first(),
      ).toBeVisible();
      const path = testInfo.outputPath(
        `token-usage-${width}-${language}-${theme}.png`,
      );
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      await testInfo.attach('Token usage overview (simulated daemon)', {
        path,
        contentType: 'image/png',
      });
      const readFonts = () =>
        Promise.all([
          model
            .getByText('qwen3.8-flash', { exact: true })
            .evaluate((element) => getComputedStyle(element).fontSize),
          model
            .getByText('71.3%', { exact: true })
            .evaluate((element) => getComputedStyle(element).fontSize),
          tokenRow.evaluate((element) => getComputedStyle(element).fontSize),
          timingGrid
            .locator('dt')
            .first()
            .evaluate((element) => getComputedStyle(element).fontSize),
          timingGrid
            .locator('dd')
            .first()
            .evaluate((element) => getComputedStyle(element).fontSize),
          hero
            .locator('..')
            .evaluate((element) => getComputedStyle(element).fontSize),
          panel
            .locator('dl')
            .first()
            .locator('strong')
            .first()
            .evaluate((element) => getComputedStyle(element).fontSize),
          mainAgent
            .getByText('95.7%', { exact: true })
            .evaluate((element) => getComputedStyle(element).fontSize),
          panel
            .locator('dl')
            .first()
            .locator('dd span')
            .first()
            .evaluate((element) => getComputedStyle(element).fontSize),
        ]);
      const dockedFonts = await readFonts();
      expect(dockedFonts).toEqual([
        '15px',
        '14px',
        '12px',
        '11px',
        '13px',
        '28px',
        '24px',
        '12px',
        '12px',
      ]);
      if (width === 1200) {
        const resize = page.locator(
          '[role="separator"][aria-orientation="vertical"][aria-valuenow]',
        );
        const initialWidth = Number(await resize.getAttribute('aria-valuenow'));
        const minWidth = Number(await resize.getAttribute('aria-valuemin'));
        const maxWidth = Number(await resize.getAttribute('aria-valuemax'));
        for (const targetWidth of [
          minWidth,
          Math.min(maxWidth, initialWidth + 120),
          initialWidth,
        ]) {
          const currentWidth = Number(
            await resize.getAttribute('aria-valuenow'),
          );
          const box = (await resize.boundingBox())!;
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(
            box.x + box.width / 2 + currentWidth - targetWidth,
            box.y + box.height / 2,
            { steps: 5 },
          );
          await page.mouse.up();
          await expect(resize).toHaveAttribute(
            'aria-valuenow',
            String(targetWidth),
          );
          expect(await readFonts()).toEqual(dockedFonts);
          await checkTimingOverflow();
          if (targetWidth === minWidth) {
            const alignment = await panel
              .getByRole('button', {
                name: zh ? '刷新' : 'Refresh',
                exact: true,
              })
              .evaluate((button) => {
                const meta = button.parentElement!.getBoundingClientRect();
                const header = button.parentElement!.parentElement!;
                const value = header.firstElementChild!.getBoundingClientRect();
                const stacked = meta.top >= value.bottom;
                return {
                  right: Math.abs(
                    meta.right - header.getBoundingClientRect().right,
                  ),
                  // At the minimum width the meta drops below the value or
                  // stays beside it, and on the zh-CN header the two states
                  // are a few pixels apart: host font metrics decide which one
                  // wins. Overlap is what this check guards, not the outcome.
                  overlap: !stacked && meta.left < value.right - 1,
                  fits: header.scrollWidth <= header.clientWidth + 1,
                };
              });
            // Wrap itself is not pinned: whether the meta still fits beside
            // the value at minimum width depends on CJK glyph widths, which
            // differ across runner images (the hz ARM64 pool keeps them on
            // one line). The invariants are right alignment, no overlap, and no
            // overflow.
            expect(alignment.right).toBeLessThanOrEqual(1);
            expect(alignment.overlap).toBe(false);
            expect(alignment.fits).toBe(true);
          }
        }
        await page
          .getByRole('button', {
            name: zh ? '全屏' : 'Fullscreen',
            exact: true,
          })
          .click();
        expect(await readFonts()).toEqual(dockedFonts);
        // Wide cards leave enough space to detect lost right alignment.
        const wideType = subagents
          .locator('[data-source-id]')
          .first()
          .getByText(zh ? '通用' : 'General-purpose', { exact: true });
        await expect
          .poll(() =>
            wideType.evaluate((type) => type.parentElement!.clientWidth),
          )
          .toBeGreaterThan(width / 2);
        expect(
          await wideType.evaluate((type) =>
            Math.abs(
              type.getBoundingClientRect().right -
                type.parentElement!.getBoundingClientRect().right,
            ),
          ),
        ).toBeLessThanOrEqual(1);
        const wideMetrics = tokenRow;
        await expect(wideMetrics).toHaveAttribute('tabindex', '0');
        expect(
          await wideMetrics.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
        await checkMetricTooltip(wideMetrics, [
          '14M',
          zh ? '12.32M（88.0%）' : '12.32M (88.0%)',
          '250K',
          '125K',
        ]);
        const referencePath = testInfo.outputPath(
          `token-usage-reference-${language}-${theme}.png`,
        );
        await panel
          .locator('section')
          .screenshot({ path: referencePath, animations: 'disabled' });
        await testInfo.attach(
          'Reference-style model ranking (simulated daemon)',
          { path: referencePath, contentType: 'image/png' },
        );
        await page
          .getByRole('button', {
            name: zh ? '退出全屏' : 'Exit fullscreen',
            exact: true,
          })
          .click();
      }
      const cards = subagents.locator('[data-source-id]');
      await expect(cards).toHaveCount(3);
      await expect(cards.first()).toBeVisible();
      await expect(cards.first()).toContainText('500K');
      await expect(
        cards.first().getByText('2.5%', { exact: true }),
      ).toBeVisible();
      await expect(cards.first()).not.toContainText('350K');
      await expect(cards.first().locator('dt')).toHaveCount(2);
      const sourceHeader = cards.first().locator(':scope > div').first();
      const sourceName = sourceHeader.getByText('Review tests e2e and docs', {
        exact: true,
      });
      const sourceType = sourceHeader.getByText(
        zh ? '通用' : 'General-purpose',
        { exact: true },
      );
      await checkContrast(sourceType, 'color', 4.5);
      await expect(sourceType).toHaveAttribute(
        'title',
        zh ? '通用' : 'General-purpose',
      );
      const nameBox = await sourceName.boundingBox();
      const typeBox = await sourceType.boundingBox();
      expect(typeBox!.x).toBeGreaterThanOrEqual(nameBox!.x + nameBox!.width);
      expect(Math.abs(typeBox!.y - nameBox!.y)).toBeLessThan(2);
      const headerBox = (await sourceHeader.boundingBox())!;
      expect(
        Math.abs(typeBox!.x + typeBox!.width - headerBox.x - headerBox.width),
      ).toBeLessThanOrEqual(1);
      await expect(cards.first().locator('dd').first()).toHaveText(
        zh ? '500K（缓存率：70.0%）' : '500K (cache rate: 70.0%)',
      );
      await checkMetricTooltip(cards.first().locator('dl'), [
        '500K',
        zh ? '350K（70.0%）' : '350K (70.0%)',
        '5K',
        '2.5K',
      ]);
      const sourceShareLabel = zh ? 'Token 占比：2.5%' : 'Token share: 2.5%';
      await cards.first().getByRole('img', { name: sourceShareLabel }).hover();
      await expect(page.getByRole('tooltip')).toHaveText(sourceShareLabel);
      await page.mouse.move(0, 0);
      await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(
        0,
      );
      await expect(cards.first()).not.toContainText(zh ? '思考' : 'Reasoning');
      await expect(
        cards.first().getByText('Review tests e2e and docs', { exact: true }),
      ).toHaveCount(1);
      await expect(cards.first()).toContainText(zh ? '输入' : 'Input');
      await expect(cards.first()).toContainText(zh ? '缓存率' : 'cache rate');
      const matchingSource = cards.nth(1);
      await expect(
        matchingSource.getByText('managed-auto-memory-extractor', {
          exact: true,
        }),
      ).toHaveCount(1);
      await expect(matchingSource).toHaveText(
        `managed-auto-memory-extractor${zh ? '输入250K（缓存率：80.0%）总输出' : 'Input250K (cache rate: 80.0%)Total output'}2.5K1.3%`,
      );
      const headings = await panel
        .getByRole('heading', { level: 3 })
        .evaluateAll((elements) =>
          elements.map((element) => {
            const style = getComputedStyle(element);
            return [style.fontSize, style.fontWeight, style.color];
          }),
        );
      for (const heading of await panel
        .getByRole('heading', { level: 3 })
        .all()) {
        await checkContrast(heading, 'color', 4.5);
      }
      expect(headings).toHaveLength(3);
      expect(headings[1]).toEqual(headings[0]);
      expect(headings[2]).toEqual(headings[0]);
      const refresh = panel.getByRole('button', {
        name: zh ? '刷新' : 'Refresh',
        exact: true,
      });
      await page.keyboard.press('Tab');
      for (const [index, target] of [
        subagents.locator(':scope > summary'),
        refresh,
        modelTrack,
        tokenRow,
      ].entries()) {
        await target.focus();
        expect(
          await target.evaluate(
            (element) =>
              element.matches(':focus-visible') &&
              getComputedStyle(element).outlineStyle !== 'none',
          ),
        ).toBe(true);
        await checkContrast(target, 'outlineColor');
        if (index > 1) await target.press('Escape');
        await target.blur();
      }
      expect(await page.evaluate(() => document.visibilityState)).toBe(
        'hidden',
      );
      expect(reads).toBe(1);
      const oldTokens = stats.models['qwen3.8-flash']!.tokens;
      stats.models['qwen3.8-flash']!.tokens = {
        ...oldTokens,
        prompt: 15000000,
        total: 15250000,
      };
      const before = reads;
      await refresh.click();
      await expect.poll(() => reads).toBe(before + 1);
      await expect(model).toHaveText(modelText('15M', '82.1', '72.7'));
      await expect(hero.locator('..')).toContainText('20.99M');
      const expandedPath = testInfo.outputPath(
        `token-usage-expanded-${width}-${language}-${theme}.png`,
      );
      await page.screenshot({
        path: expandedPath,
        fullPage: true,
        animations: 'disabled',
      });
      await testInfo.attach('Expanded token details (simulated daemon)', {
        path: expandedPath,
        contentType: 'image/png',
      });
      expect(
        await panel.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
    });
  });
}
