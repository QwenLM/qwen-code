/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FORM_VALUES,
  runActivityForm,
  runBillSplitter,
  runChecklist,
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

    async function newView(page: Page, html: string, toolCallId?: string) {
      const before = page.frames().length;
      await page.evaluate((id) => {
        const frame = document.createElement('iframe');
        frame.name = 'view';
        if (id) {
          const row = document.createElement('div');
          row.dataset.transcriptToolCallId = id;
          row.append(frame);
          document.body.append(row);
        } else {
          document.body.append(frame);
        }
      }, toolCallId);
      const frame = page.frames()[before];
      await frame.setContent(html);
      return frame;
    }

    const formDetails =
      ' Date: 2026-12-05. Budget: CNY 180 per person. Notes: two vegetarians.';
    it.each<{
      submissions: number;
      batched: boolean;
      additionalUserTurn?: boolean;
      answer?: string;
      answerUsesValues?: boolean;
    }>([
      { submissions: 1, batched: false },
      { submissions: 2, batched: false },
      { submissions: 2, batched: true },
      { submissions: 1, batched: false, additionalUserTurn: true },
      { submissions: 1, batched: true, additionalUserTurn: true },
      {
        submissions: 1,
        batched: false,
        answer: '**12** people should try the escape room.' + formDetails,
      },
      {
        submissions: 1,
        batched: false,
        answer: 'A 12-person team should try the escape room.' + formDetails,
      },
      {
        submissions: 1,
        batched: false,
        answer: '建议 12 人一起体验密室逃脱。' + formDetails,
      },
      {
        submissions: 1,
        batched: false,
        answer: '人数：12，建议密室逃脱。' + formDetails,
      },
      {
        submissions: 1,
        batched: false,
        answer: '共12个人一起体验密室逃脱。' + formDetails,
      },
      {
        submissions: 1,
        batched: false,
        answer: '建议 12 名同事参加密室逃脱。' + formDetails,
      },
      {
        submissions: 1,
        batched: false,
        answer: 'Participants: 12. Activity: escape room.' + formDetails,
      },
      {
        submissions: 1,
        batched: false,
        answer: 'For 8 people, choose an escape room.' + formDetails,
        answerUsesValues: false,
      },
      {
        submissions: 1,
        batched: false,
        answer: 'For 112 people, choose an escape room.' + formDetails,
        answerUsesValues: false,
      },
      {
        submissions: 1,
        batched: false,
        answer: 'Participants: 12.5. Activity: escape room.' + formDetails,
        answerUsesValues: false,
      },
      ...[
        formDetails.replace('2026-12-05', '2026-12-19'),
        formDetails.replace('180 per person', '999 per person (CNY 180 total)'),
        formDetails.replace('two vegetarians', 'no dietary needs'),
      ].map((details) => ({
        submissions: 1,
        batched: false,
        answer: 'For 12 people, choose an escape room.' + details,
        answerUsesValues: false,
      })),
    ])(
      'counts $submissions submissions (batched=$batched, additional=$additionalUserTurn) and checks answer=$answer',
      async ({
        submissions,
        batched,
        additionalUserTurn = false,
        answer = '12 people should try the escape room.' + formDetails,
        answerUsesValues = true,
      }) => {
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
            if (additionalUserTurn) {
              messages.push({
                role: 'user',
                content: 'Unexpected extra message',
              });
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
              didSubmit ? ['Form ready', answer] : ['Form ready'],
          } as unknown as AcceptanceEnv;

          const results = await runActivityForm(env, 'form');
          expect(
            results.find((check) => check.id === 'form.one-submission')?.status,
          ).toBe(submissions === 1 && !additionalUserTurn ? 'pass' : 'fail');
          expect(
            results.find((check) => check.id === 'form.submits-every-field')
              ?.status,
          ).toBe('pass');
          expect(
            results.find((check) => check.id === 'form.answer-uses-values')
              ?.status,
          ).toBe(answerUsesValues ? 'pass' : 'fail');
        } finally {
          await page.close();
        }
      },
    );

    it.each([
      'control',
      'reversed',
      'regenerated-chart-id',
      'regenerated-chart-aria-id',
      'split-share-label',
      'canvas-chart',
      'css-chart',
      'unchanged-chart',
      'empty-chart',
      'stale-subtotal',
      'stale-discount',
      'stale-service-rate',
      'stale-chart',
      'stale-chart-data',
      'stale-chart-root',
      'stale-chart-canvas',
    ] as const)(
      'checks bill allocation order and complete reset behavior: %s',
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
              const canvasChart = ['canvas-chart', 'stale-chart-canvas'].includes(${JSON.stringify(mode)});
              if (canvasChart) document.getElementById('chart').outerHTML = '<canvas id="chart" width="200" height="100"></canvas>';
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
                document.getElementById('shares').innerHTML = ${JSON.stringify(mode)} === 'split-share-label'
                  ? shares.map((share, i) => '<li><span>' + (i + 1) + '</span><span>' + (share / 100).toFixed(2) + '</span></li>').join('')
                  : shares.map((share, i) => '<li>Person ' + (i + 1) + ': ' + (share / 100).toFixed(2) + '</li>').join('');
                // A canvas chart has no markup: only its pixels change.
                if (!canvasChart) document.getElementById('chart').innerHTML = '<svg viewBox="0 0 ' + people * 30 + ' 100"><rect width="' + people + '" height="10"></rect></svg>';
                if (${JSON.stringify(mode)} === 'css-chart') document.getElementById('chart').innerHTML = '<div style="background:blue;height:10px;width:' + people * 10 + 'px"></div>';
                if (${JSON.stringify(mode)} === 'unchanged-chart') document.getElementById('chart').innerHTML = '<svg><rect width="6" height="10"></rect></svg>';
                if (${JSON.stringify(mode)} === 'empty-chart') document.getElementById('chart').innerHTML = '';
                if (canvasChart) {
                  const context = document.getElementById('chart').getContext('2d');
                  context.clearRect(0, 0, 200, 100);
                  context.fillRect(0, 0, people * 10, 10);
                }
                if (${JSON.stringify(mode)} === 'stale-chart-root') document.getElementById('chart').style.transform = 'scaleX(' + people / 6 + ')';
                if (${JSON.stringify(mode)} === 'regenerated-chart-id') {
                  const svg = document.querySelector('#chart svg');
                  svg.id = 'chart-' + Math.random();
                  const gradient = 'gradient-' + Math.random();
                  svg.insertAdjacentHTML('afterbegin', '<defs><linearGradient id="' + gradient + '"><stop offset="0" stop-color="black" /></linearGradient></defs>');
                  svg.querySelector('rect').setAttribute('fill', 'url(#' + gradient + ')');
                }
                if (${JSON.stringify(mode)} === 'regenerated-chart-aria-id') {
                  const svg = document.querySelector('#chart svg');
                  const title = 'title-' + Math.random();
                  const bar = 'bar-' + Math.random();
                  svg.setAttribute('aria-labelledby', title);
                  svg.insertAdjacentHTML('afterbegin', '<title id="' + title + '">Shares</title><style>#' + bar + ' { fill: teal; }</style>');
                  svg.querySelector('rect').id = bar;
                }
                if (${JSON.stringify(mode)} === 'stale-chart-data') {
                  const svg = document.querySelector('#chart svg');
                  svg.insertAdjacentHTML('afterbegin', '<style>rect[data-people="7"] { width: 7px; }</style>');
                  const rect = svg.querySelector('rect');
                  rect.setAttribute('width', '6');
                  rect.dataset.people = String(people);
                }
                if (food === 90000 && people === 7 && discount === 6100 && rate === 15) window.observedScenario = [...shares];
              }
              document.addEventListener('input', render);
              document.getElementById('reset').onclick = () => {
                const fault = ${JSON.stringify(mode)}.replace('stale-', '');
                const staleInput = document.getElementById(fault)?.value;
                const staleChart = document.getElementById('chart').innerHTML;
                const staleChartData = document.querySelector('#chart rect')?.dataset.people;
                const staleChartStyle = document.getElementById('chart').getAttribute('style');
                const stalePixels = canvasChart ? document.getElementById('chart').getContext('2d').getImageData(0, 0, 200, 100) : null;
                for (const [id, value] of Object.entries({ subtotal: '900', people: '6', discount: '60', 'service-rate': '10' })) document.getElementById(id).value = value;
                render();
                if (staleInput !== undefined) document.getElementById(fault).value = staleInput;
                if (fault === 'chart') document.getElementById('chart').innerHTML = staleChart;
                if (fault === 'chart-data') document.querySelector('#chart rect').dataset.people = staleChartData;
                if (fault === 'chart-root') document.getElementById('chart').setAttribute('style', staleChartStyle);
                if (fault === 'chart-canvas') document.getElementById('chart').getContext('2d').putImageData(stalePixels, 0, 0);
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
            mode === 'reversed' ? [...expected].reverse() : expected,
          );
          expect(
            results.find(({ id }) => id === 'bill.conserves-cents')?.status,
          ).toBe('pass');
          expect(
            results.find(({ id }) => id === 'bill.fair-rounding')?.status,
          ).toBe('pass');
          expect(results.find(({ id }) => id === 'bill.scenario')?.status).toBe(
            mode === 'reversed' ? 'fail' : 'pass',
          );
          expect(results.find(({ id }) => id === 'bill.reset')?.status).toBe(
            mode.startsWith('stale-') ? 'fail' : 'pass',
          );
          expect(
            results.find(({ id }) => id === 'bill.chart-updates')?.status,
          ).toBe(
            mode === 'unchanged-chart' || mode === 'empty-chart'
              ? 'fail'
              : 'pass',
          );
          if (mode === 'stale-chart-root') {
            expect(
              await view
                .locator('#chart')
                .evaluate((element) => getComputedStyle(element).transform),
            ).not.toBe('matrix(1, 0, 0, 1, 0, 0)');
          }
          if (mode === 'canvas-chart' || mode === 'stale-chart-canvas') {
            const alpha = await view
              .locator('#chart')
              .evaluate(
                (element) =>
                  (element as HTMLCanvasElement)
                    .getContext('2d')!
                    .getImageData(65, 5, 1, 1).data[3],
              );
            expect(alpha).toBe(mode === 'canvas-chart' ? 0 : 255);
          }
        } finally {
          await page.close();
        }
      },
    );

    it.each([
      'control',
      'completed-last',
      'progress-loss',
      'history-loss',
      'inert-add',
      'no-edit',
      'inert-edit',
    ] as const)(
      'checks checklist progress and undo persistence: %s',
      async (mode) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        const token = 'acceptance-test-token';
        try {
          const html = `
            <input id="new-item"><select id="filter"><option value="all">All</option><option value="open">Open</option><option value="done">Done</option></select>
            <button id="add">Add</button><button id="undo">Undo</button><p id="empty">Empty</p><ul id="items"></ul>
            <script>
              const key = 'checklist-' + new URL(location.href).searchParams.get('session');
              const saved = JSON.parse(localStorage.getItem(key) || 'null');
              let items = saved?.items || [];
              let history = saved?.history || [];
              const byId = id => document.getElementById(id);
              const snapshot = () => JSON.parse(JSON.stringify(items));
              function applyFilter() {
                const filter = byId('filter').value;
                for (const row of byId('items').children) {
                  row.hidden = filter !== 'all' && filter !== row.dataset.status;
                }
              }
              function render() {
                byId('empty').hidden = !!items.length;
                byId('items').innerHTML = '';
                const ordered = items.map((item, index) => ({ item, index }));
                if (${JSON.stringify(mode)} === 'completed-last') ordered.sort((a, b) => Number(a.item.done) - Number(b.item.done));
                ordered.forEach(({ item, index }) => {
                  const slot = 'item-' + (index + 1);
                  const row = document.createElement('li');
                  row.dataset.status = item.done ? 'done' : 'open';
                  const text = ${JSON.stringify(mode)} === 'no-edit'
                    ? '<span id="' + slot + '-text"></span>'
                    : '<input id="' + slot + '-text">';
                  row.innerHTML = '<input type="checkbox" id="' + slot + '-check">' + text + '<button id="' + slot + '-delete">Delete</button>';
                  byId('items').append(row);
                  if (${JSON.stringify(mode)} === 'no-edit') byId(slot + '-text').textContent = item.text;
                  else byId(slot + '-text').value = item.text;
                  if (${JSON.stringify(mode)} !== 'inert-edit') {
                    byId(slot + '-text').onchange = event => { history.push(snapshot()); item.text = event.target.value; render(); };
                  }
                  byId(slot + '-check').checked = item.done;
                  byId(slot + '-check').onchange = event => { history.push(snapshot()); item.done = event.target.checked; render(); };
                  byId(slot + '-delete').onclick = () => { history.push(snapshot()); items.splice(index, 1); render(); };
                });
                applyFilter();
                localStorage.setItem(key, JSON.stringify({
                  items: ${JSON.stringify(mode)} === 'progress-loss' ? items.map(item => ({ ...item, done: false })) : items,
                  history: ${JSON.stringify(mode)} === 'history-loss' ? [] : history,
                }));
              }
              byId('add').onclick = () => {
                if (${JSON.stringify(mode)} === 'inert-add') return;
                history.push(snapshot()); items.push({ text: byId('new-item').value, done: false }); byId('new-item').value = ''; render();
              };
              byId('filter').onchange = applyFilter;
              byId('undo').onclick = () => { if (history.length) items = history.pop(); render(); };
              render();
            </script>`;
          await context.route('http://acceptance.test/**', async (route) => {
            const url = new URL(route.request().url());
            await route.fulfill({
              contentType: 'text/html',
              body:
                url.pathname === '/view'
                  ? html
                  : `<body><script>
                      const supplied = new URLSearchParams(location.hash.slice(1)).get('token');
                      if (supplied) sessionStorage.setItem('daemon-token', supplied);
                      history.replaceState(null, '', location.pathname + location.search);
                      if (sessionStorage.getItem('daemon-token') === ${JSON.stringify(token)}) {
                        document.body.insertAdjacentHTML('beforeend', '<iframe name="view" src="/view' + location.search + '"></iframe>');
                      }
                    </script></body>`,
            });
          });
          let starts = 0;
          let checkedBeforeReload = false;
          let reopenedAuthenticated = false;
          const newPage = context.newPage.bind(context);
          vi.spyOn(context, 'newPage').mockImplementation(async () => {
            const reopened = await newPage();
            const goto = reopened.goto.bind(reopened);
            vi.spyOn(reopened, 'goto').mockImplementation(
              async (url, options) => {
                const response = await goto(url, options);
                reopenedAuthenticated =
                  (await reopened.evaluate(() =>
                    sessionStorage.getItem('daemon-token'),
                  )) === token;
                expect(reopenedAuthenticated).toBe(true);
                expect(new URL(reopened.url()).hash).toBe('');
                return response;
              },
            );
            return reopened;
          });
          const reload = page.reload.bind(page);
          vi.spyOn(page, 'reload').mockImplementation(async (options) => {
            const card = await waitForCardOn(page, 0);
            checkedBeforeReload = await card.view
              .locator('#item-2-check')
              .isChecked();
            return reload(options);
          });
          const env = {
            page,
            context,
            cardTimeoutMs: 10_000,
            daemon: { token },
            startSession: async () => {
              await page.goto(
                `http://acceptance.test/?session=${++starts}#token=${token}`,
              );
            },
            waitForCard: (index: number) => waitForCardOn(page, index),
            waitForIdle: async () => {},
          } as unknown as AcceptanceEnv;

          const results = await runChecklist(env, 'checklist');
          const status = (id: string) =>
            results.find((check) => check.id === `checklist.${id}`)?.status;
          // The same ids in every mode: unreached checks are not-applicable.
          expect(results.map((check) => check.id).sort()).toEqual(
            [
              'add',
              'check-and-filter',
              'delete',
              'edit',
              'empty-state',
              'isolated-across-sessions',
              'persists-after-reload',
              'persists-after-reopen',
              'repeated-undo',
              'save-acknowledged',
            ].map((id) => `checklist.${id}`),
          );
          // The reopened tab stays open while it is read, then is closed.
          expect(context.pages()).toEqual([page]);
          if (mode === 'inert-add') {
            expect(status('add')).toBe('fail');
            for (const id of [
              'check-and-filter',
              'delete',
              'repeated-undo',
              'edit',
            ]) {
              expect(status(id)).toBe('not-applicable');
            }
            return;
          }
          expect(checkedBeforeReload).toBe(true);
          expect(reopenedAuthenticated).toBe(true);
          for (const id of ['persists-after-reload', 'persists-after-reopen']) {
            expect(status(id)).toBe(
              mode === 'progress-loss' || mode === 'history-loss'
                ? 'fail'
                : 'pass',
            );
          }
          for (const id of [
            'add',
            'check-and-filter',
            'delete',
            'repeated-undo',
            'isolated-across-sessions',
          ]) {
            expect(status(id)).toBe('pass');
          }
          expect(status('edit')).toBe(
            mode === 'no-edit' || mode === 'inert-edit' ? 'fail' : 'pass',
          );
          // Nothing the host offers acknowledges a save yet.
          expect(status('save-acknowledged')).toBe('not-applicable');
        } finally {
          await context.close();
        }
      },
    );

    it.each([
      { mode: 'in-place', resetFault: 'none', initialPlan: 'basic' },
      { mode: 'new-card', resetFault: 'none', initialPlan: 'basic' },
      { mode: 'replace-card', resetFault: 'none', initialPlan: 'basic' },
      { mode: 'in-place', resetFault: 'none', initialPlan: 'pro' },
      { mode: 'in-place', resetFault: 'billing', initialPlan: 'basic' },
      { mode: 'in-place', resetFault: 'plan', initialPlan: 'basic' },
      { mode: 'in-place', resetFault: 'amounts', initialPlan: 'basic' },
      { mode: 'in-place', resetFault: 'none', initialPlan: null },
      { mode: 'new-card', resetFault: 'none', initialPlan: null },
      { mode: 'in-place', resetFault: 'plan', initialPlan: null },
      {
        mode: 'in-place',
        resetFault: 'none',
        initialPlan: 'basic',
        exportMode: 'wrong-plan',
      },
      {
        mode: 'in-place',
        resetFault: 'none',
        initialPlan: 'basic',
        exportMode: 'moving-button',
      },
    ])(
      'observes $mode comparator updates (reset=$resetFault, initialPlan=$initialPlan, export=$exportMode)',
      async ({ mode, resetFault, initialPlan, exportMode }) => {
        const initialAnnual = initialPlan === 'pro';
        const page = await browser.newPage();
        page.setDefaultTimeout(1_000);
        try {
          vi.spyOn(page, 'waitForTimeout').mockResolvedValue();
          const csv =
            exportMode === 'wrong-plan'
              ? 'plan,payment\npro,14227.20\nteam,0\n'
              : '"plan","payment"\r\n"team","14,227.2"\r\n';
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
              document.getElementById('export').onclick = () => {
                const link = document.createElement('a');
                link.href = URL.createObjectURL(new Blob([${JSON.stringify(csv)}], { type: 'text/csv' }));
                link.download = 'comparator.csv';
                link.click();
              };
              render();
            </script>`;
          let cardCount = 1;
          let view = await newView(page, html, 'call-1');
          const initialPayment = await view
            .locator('#team-payment')
            .textContent();
          const env = {
            page,
            cardTimeoutMs: 100,
            startSession: async () => {},
            waitForCard: (index: number) => waitForCardOn(page, index, 100),
            waitForIdle: async () => {},
            send: async (prompt: string) => {
              const reset = prompt === 'reset';
              if (mode === 'replace-card') {
                await page
                  .locator('[data-transcript-tool-call-id]')
                  .last()
                  .evaluate((row) => row.remove());
              }
              if (mode !== 'in-place') {
                view = await newView(page, html, `call-${++cardCount}`);
              }
              await view.evaluate(
                ({
                  reset,
                  resetFault,
                  initialAnnual,
                  initialPlan,
                  exportMode,
                }) => {
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
                  if (!reset && exportMode === 'moving-button') {
                    document
                      .getElementById('export')!
                      .animate(
                        [
                          { transform: 'translateX(0px)' },
                          { transform: 'translateX(80px)' },
                        ],
                        { duration: 4_500, fill: 'forwards' },
                      );
                  }
                },
                { reset, resetFault, initialAnnual, initialPlan, exportMode },
              );
            },
          } as unknown as AcceptanceEnv;

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
            'comparator.exports-current-csv':
              exportMode === 'wrong-plan' ? 'fail' : 'pass',
            'comparator.reset-via-follow-up':
              resetFault === 'none' ? 'pass' : 'fail',
          });
        } finally {
          await page.close();
        }
      },
    );

    it.each(['no-seats', 'no-follow-up-card'] as const)(
      'reports every comparator check when %s',
      async (fault) => {
        const page = await browser.newPage();
        page.setDefaultTimeout(1_000);
        try {
          vi.spyOn(page, 'waitForTimeout').mockResolvedValue();
          const view = await newView(
            page,
            `${fault === 'no-seats' ? '' : '<input id="seats" value="6">'}
            <input type="radio" name="billing" id="billing-monthly" checked>
            <input type="radio" name="billing" id="billing-annual">
            <input type="radio" name="plan" id="plan-basic" checked>
            <input type="radio" name="plan" id="plan-pro"><input type="radio" name="plan" id="plan-team">
            <input id="support" type="checkbox"><button id="export">Export</button>
            <span id="basic-monthly"></span><span id="basic-payment"></span>
            <span id="pro-monthly"></span><span id="pro-payment"></span>
            <span id="team-monthly"></span><span id="team-payment"></span>`,
            'call-1',
          );
          const env = {
            page,
            cardTimeoutMs: 100,
            startSession: async () => {},
            waitForCard: async () => ({ view, app: page.mainFrame() }),
            waitForIdle: async () => {},
            send: async () => {},
          } as unknown as AcceptanceEnv;
          const exported = vi.spyOn(page, 'waitForEvent');

          const results = await runComparator(env, {
            initial: 'initial',
            support: 'support',
            reset: 'reset',
          });
          const statuses = Object.fromEntries(
            results.map(({ id, status }) => [id, status]),
          );
          expect(Object.keys(statuses).sort()).toEqual(
            [
              'exports-current-csv',
              'extends-existing-card',
              'keeps-choices',
              'monthly-vs-payment',
              'reset-via-follow-up',
              'support-totals',
            ].map((id) => `comparator.${id}`),
          );
          expect(statuses['comparator.monthly-vs-payment']).toBe('fail');
          expect(statuses['comparator.support-totals']).toBe('fail');
          if (fault === 'no-follow-up-card') {
            // Nothing to measure after the follow-up, and the export is not
            // measured on the earlier card instead.
            expect(statuses).toMatchObject({
              'comparator.keeps-choices': 'not-applicable',
              'comparator.extends-existing-card': 'not-applicable',
              'comparator.exports-current-csv': 'not-applicable',
            });
            expect(exported).not.toHaveBeenCalled();
          }
        } finally {
          await page.close();
        }
      },
    );
  },
);
