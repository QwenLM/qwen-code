/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Readable } from 'node:stream';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FORM_VALUES,
  runActivityForm,
  runBillSplitter,
  runComparator,
} from './cases.js';
import {
  waitForCardOn,
  type AcceptanceEnv,
  type ChatMessage,
  type RecordedRequest,
} from './harness.js';

vi.mock('../cli/_daemon-harness.js', () => ({
  DEFAULT_CLI_BIN: 'unused',
  spawnDaemon: vi.fn(),
}));

// These test evaluator classification with real DOM and controlled host data.
// Like replay, they need Chromium and are opt-in.
describe.runIf(process.env['QWEN_GENERATED_UI_ACCEPTANCE'] === '1')(
  'acceptance evaluator classification',
  () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch({ headless: true });
    });
    afterAll(async () => {
      await browser?.close();
    });

    async function newView(page: Page, html: string) {
      const before = page.frames().length;
      await page.evaluate(() => {
        const frame = document.createElement('iframe');
        frame.name = 'view';
        document.body.append(frame);
      });
      const frame = page.frames()[before];
      await frame.setContent(html);
      return frame;
    }

    it.each([
      { submissions: 1, batched: false },
      { submissions: 2, batched: false },
      { submissions: 2, batched: true },
    ])(
      'counts $submissions identical user submissions (batched=$batched)',
      async ({ submissions, batched }) => {
        const page = await browser.newPage();
        try {
          vi.spyOn(page, 'waitForTimeout').mockResolvedValue();
          await page.setContent(
            '<button id="continue-analysis">Continue</button>' +
              '<p id="continuation-status" data-state="idle">Idle</p>',
          );
          const form = await newView(
            page,
            '<select id="activity"><option value="escape-room">Escape room</option></select>' +
              '<input id="date"><input id="participants"><input id="budget"><textarea id="notes"></textarea>',
          );
          const submittedText = JSON.stringify({
            inputs: Object.fromEntries(
              Object.entries(FORM_VALUES).map(([id, value]) => [
                id,
                { value, checked: false },
              ]),
            ),
          });
          const initial: ChatMessage = {
            role: 'user',
            content: 'show an activity form',
          };
          const request = (messages: ChatMessage[]): RecordedRequest => ({
            messages: [...messages],
            tools: [],
            main: true,
            lastUserText: String(
              messages.findLast((message) => message.role === 'user')
                ?.content ?? '',
            ),
          });
          const requests = [request([initial])];
          let didSubmit = false;
          await page.exposeFunction('submitForm', () => {
            didSubmit = true;
            const messages = [initial];
            for (let index = 0; index < submissions; index++) {
              messages.push({ role: 'user', content: submittedText });
              if (!batched) requests.push(request(messages));
              messages.push({ role: 'assistant', content: 'Response' });
            }
            // A retry or tool continuation repeats the existing user turn.
            requests.push(request(messages));
          });
          await page.evaluate(() => {
            document
              .getElementById('continue-analysis')!
              .addEventListener('click', async () => {
                await (
                  window as unknown as { submitForm(): Promise<void> }
                ).submitForm();
                const status = document.getElementById('continuation-status')!;
                status.dataset.state = 'accepted';
                status.textContent = 'Accepted';
              });
          });
          const env = {
            page,
            cardTimeoutMs: 100,
            startSession: async () => {},
            waitForCard: async () => ({ view: form, app: page.mainFrame() }),
            waitForIdle: async () => {},
            mainRequests: () => requests,
            assistantTexts: async () =>
              didSubmit
                ? ['Form ready', '12 people should try the escape room']
                : ['Form ready'],
          } as unknown as AcceptanceEnv;

          const results = await runActivityForm(env, 'form');
          expect(
            results.find((check) => check.id === 'form.one-submission')?.status,
          ).toBe(submissions === 1 ? 'pass' : 'fail');
          expect(
            results.find((check) => check.id === 'form.submits-every-field')
              ?.status,
          ).toBe('pass');
        } finally {
          await page.close();
        }
      },
    );

    it.each(['control', 'reversed'] as const)(
      'checks bill allocation order: %s',
      async (mode) => {
        const page = await browser.newPage();
        try {
          vi.spyOn(page, 'waitForTimeout').mockResolvedValue();
          await page.evaluate(() => {
            let copied = '';
            Object.defineProperty(navigator, 'clipboard', {
              value: {
                writeText: async (value: string) => {
                  copied = value;
                },
                readText: async () => copied,
              },
            });
          });
          const view = await newView(
            page,
            `
            <input id="subtotal" value="900"><input id="people" value="6">
            <input id="discount" value="60"><input id="service-rate" value="10">
            <p id="error"></p><output id="total"></output><ul id="shares"></ul><div id="chart"></div>
            <button id="reset">Reset</button><button id="copy">Copy</button>
            <script>
              function render() {
                const food = Math.round(Number(document.getElementById('subtotal').value) * 100);
                const people = Number(document.getElementById('people').value);
                const discount = Math.round(Number(document.getElementById('discount').value) * 100);
                const rate = Number(document.getElementById('service-rate').value);
                if (!Number.isInteger(people) || people < 1) {
                  document.getElementById('error').textContent = 'Invalid people';
                  return;
                }
                document.getElementById('error').textContent = '';
                const total = Math.round((food - discount) * (100 + rate) / 100);
                const base = Math.floor(total / people);
                const shares = Array.from({ length: people }, (_, i) => base + (i < total % people ? 1 : 0));
                if (${JSON.stringify(mode)} === 'reversed') shares.reverse();
                document.getElementById('total').textContent = (total / 100).toFixed(2);
                document.getElementById('shares').innerHTML = shares.map((share, i) => '<li>Person ' + (i + 1) + ': ' + (share / 100).toFixed(2) + '</li>').join('');
                document.getElementById('chart').innerHTML = '<svg viewBox="0 0 ' + people * 30 + ' 100"><rect width="' + people + '" height="10"></rect></svg>';
                if (people === 7 && discount === 6100 && rate === 15) window.observedScenario = [...shares];
              }
              document.addEventListener('input', render);
              document.getElementById('reset').onclick = () => {
                for (const [id, value] of Object.entries({ subtotal: '900', people: '6', discount: '60', 'service-rate': '10' })) document.getElementById(id).value = value;
                render();
              };
              document.getElementById('copy').onclick = () => parent.navigator.clipboard.writeText(document.getElementById('total').textContent);
              render();
            </script>`,
          );
          const env = {
            page,
            startSession: async () => {},
            waitForCard: async () => ({ view, app: page.mainFrame() }),
            waitForIdle: async () => {},
            mainRequests: () => [],
          } as unknown as AcceptanceEnv;

          const results = await runBillSplitter(env, 'bill');
          const shares = await view.evaluate(
            () =>
              (window as unknown as { observedScenario: number[] })
                .observedScenario,
          );
          const expected = [13784, 13784, 13784, 13784, 13783, 13783, 13783];
          expect(shares).toEqual(
            mode === 'control' ? expected : [...expected].reverse(),
          );
          expect(
            results.find(({ id }) => id === 'bill.conserves-cents')?.status,
          ).toBe('pass');
          expect(
            results.find(({ id }) => id === 'bill.fair-rounding')?.status,
          ).toBe('pass');
          expect(results.find(({ id }) => id === 'bill.scenario')?.status).toBe(
            mode === 'control' ? 'pass' : 'fail',
          );
        } finally {
          await page.close();
        }
      },
    );

    it.each([
      { mode: 'in-place', resetFault: 'none', initialPlan: 'basic' },
      { mode: 'new-card', resetFault: 'none', initialPlan: 'basic' },
      { mode: 'in-place', resetFault: 'none', initialPlan: 'pro' },
      { mode: 'in-place', resetFault: 'billing', initialPlan: 'basic' },
      { mode: 'in-place', resetFault: 'plan', initialPlan: 'basic' },
      { mode: 'in-place', resetFault: 'amounts', initialPlan: 'basic' },
      { mode: 'in-place', resetFault: 'none', initialPlan: null },
      { mode: 'new-card', resetFault: 'none', initialPlan: null },
      { mode: 'in-place', resetFault: 'plan', initialPlan: null },
    ] as const)(
      'observes $mode comparator updates (reset=$resetFault, initialPlan=$initialPlan)',
      async ({ mode, resetFault, initialPlan }) => {
        const initialAnnual = initialPlan === 'pro';
        const page = await browser.newPage();
        page.setDefaultTimeout(1_000);
        try {
          vi.spyOn(page, 'waitForTimeout').mockResolvedValue();
          const html = `
            <input id="seats" value="6">
            <input type="radio" name="billing" id="billing-monthly" ${initialAnnual ? '' : 'checked'}>
            <input type="radio" name="billing" id="billing-annual" ${initialAnnual ? 'checked' : ''}>
            <input type="radio" name="plan" id="plan-basic" ${initialPlan === 'basic' ? 'checked' : ''}>
            <input type="radio" name="plan" id="plan-pro" ${initialPlan === 'pro' ? 'checked' : ''}>
            <input type="radio" name="plan" id="plan-team">
            <input id="support" type="checkbox"><button id="export">Export</button>
            <span id="basic-monthly"></span><span id="basic-payment"></span>
            <span id="pro-monthly"></span><span id="pro-payment"></span>
            <span id="team-monthly"></span><span id="team-payment"></span>
            <script>
              function render() {
                const seats = Number(document.getElementById('seats').value);
                const annual = document.getElementById('billing-annual').checked;
                const support = document.getElementById('support').checked;
                for (const [plan, price] of Object.entries({ basic: 39, pro: 69, team: 99 })) {
                  const monthly = seats * (price * (annual ? 0.8 : 1) + (support ? 12 : 0));
                  document.getElementById(plan + '-monthly').textContent = monthly.toFixed(2);
                  document.getElementById(plan + '-payment').textContent = (monthly * (annual ? 12 : 1)).toFixed(2);
                }
              }
              document.addEventListener('input', render);
              document.addEventListener('change', render);
              render();
            </script>`;
          let view = await newView(page, html);
          const initialPayment = await view
            .locator('#team-payment')
            .textContent();
          const env = {
            page,
            startSession: async () => {},
            waitForCard: (index: number) => waitForCardOn(page, index, 100),
            waitForIdle: async () => {},
            send: async (prompt: string) => {
              const reset = prompt === 'reset';
              if (mode === 'new-card') view = await newView(page, html);
              await view.evaluate(
                ({ reset, resetFault, initialAnnual, initialPlan }) => {
                  (
                    document.getElementById('support') as HTMLInputElement
                  ).checked = !reset;
                  (document.getElementById('seats') as HTMLInputElement).value =
                    reset ? '6' : '13';
                  (
                    document.getElementById(
                      !reset || resetFault === 'billing' || initialAnnual
                        ? 'billing-annual'
                        : 'billing-monthly',
                    ) as HTMLInputElement
                  ).checked = true;
                  const plan =
                    !reset || resetFault === 'plan' ? 'team' : initialPlan;
                  for (const input of document.querySelectorAll<HTMLInputElement>(
                    'input[name="plan"]',
                  ))
                    input.checked = false;
                  if (plan)
                    (
                      document.getElementById(
                        `plan-${plan}`,
                      ) as HTMLInputElement
                    ).checked = true;
                  if (!reset || resetFault !== 'amounts')
                    document.dispatchEvent(new Event('input'));
                },
                { reset, resetFault, initialAnnual, initialPlan },
              );
            },
          } as unknown as AcceptanceEnv;
          vi.spyOn(page, 'waitForEvent').mockResolvedValue({
            createReadStream: async () =>
              Readable.from(['plan,payment\nteam,14227.20\n']),
          } as never);

          const results = await runComparator(env, {
            initial: 'initial',
            support: 'support',
            reset: 'reset',
          });
          const statuses = Object.fromEntries(
            results.map(({ id, status }) => [id, status]),
          );
          expect(await view.locator('#billing-annual').isChecked()).toBe(
            initialAnnual || resetFault === 'billing',
          );
          const expectedPlan = resetFault === 'plan' ? 'team' : initialPlan;
          expect(
            await view
              .locator('input[name="plan"]:checked')
              .evaluateAll((inputs) => inputs.map((input) => input.id)),
          ).toEqual(expectedPlan ? [`plan-${expectedPlan}`] : []);
          expect(await view.locator('#team-payment').textContent()).toBe(
            resetFault === 'amounts'
              ? '14227.20'
              : resetFault === 'billing'
                ? '5702.40'
                : initialPayment,
          );
          expect(statuses).toEqual({
            'comparator.monthly-vs-payment': 'pass',
            'comparator.support-totals': 'pass',
            'comparator.keeps-choices': 'pass',
            'comparator.extends-existing-card':
              mode === 'in-place' ? 'pass' : 'fail',
            'comparator.exports-current-csv': 'pass',
            'comparator.reset-via-follow-up':
              resetFault === 'none' ? 'pass' : 'fail',
          });
        } finally {
          await page.close();
        }
      },
    );
  },
);
