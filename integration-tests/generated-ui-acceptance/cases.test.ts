/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Readable } from 'node:stream';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FORM_VALUES, runActivityForm, runComparator } from './cases.js';
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

    it.each(['in-place', 'new-card'] as const)(
      'observes a comparator follow-up using %s updates',
      async (mode) => {
        const page = await browser.newPage();
        try {
          vi.spyOn(page, 'waitForTimeout').mockResolvedValue();
          const html = `
            <input id="seats" value="6">
            <input type="radio" name="billing" id="billing-monthly" checked>
            <input type="radio" name="billing" id="billing-annual">
            <input type="radio" name="plan" id="plan-basic" checked>
            <input type="radio" name="plan" id="plan-pro">
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
          const env = {
            page,
            startSession: async () => {},
            waitForCard: (index: number) => waitForCardOn(page, index, 100),
            waitForIdle: async () => {},
            send: async (prompt: string) => {
              const reset = prompt === 'reset';
              if (mode === 'new-card') view = await newView(page, html);
              await view.evaluate((reset) => {
                (
                  document.getElementById('support') as HTMLInputElement
                ).checked = !reset;
                (document.getElementById('seats') as HTMLInputElement).value =
                  reset ? '6' : '13';
                (
                  document.getElementById(
                    reset ? 'billing-monthly' : 'billing-annual',
                  ) as HTMLInputElement
                ).checked = true;
                (
                  document.getElementById(
                    reset ? 'plan-basic' : 'plan-team',
                  ) as HTMLInputElement
                ).checked = true;
                document.dispatchEvent(new Event('input'));
              }, reset);
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
          expect(statuses).toEqual({
            'comparator.monthly-vs-payment': 'pass',
            'comparator.support-totals': 'pass',
            'comparator.keeps-choices': 'pass',
            'comparator.extends-existing-card':
              mode === 'in-place' ? 'pass' : 'fail',
            'comparator.exports-current-csv': 'pass',
            'comparator.reset-via-follow-up': 'pass',
          });
        } finally {
          await page.close();
        }
      },
    );
  },
);
