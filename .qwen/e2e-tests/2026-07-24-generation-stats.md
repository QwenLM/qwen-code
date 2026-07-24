# Generation timing metrics in `/stats`

## Automated verification

Run the focused Core tests:

```bash
cd packages/core
npx vitest run src/telemetry/uiTelemetry.test.ts
npx vitest run src/core/loggingContentGenerator/loggingContentGenerator.test.ts
```

Run the focused CLI tests:

```bash
cd packages/cli
npx vitest run src/ui/commands/statsCommand.test.ts
npx vitest run src/ui/components/StatsSessionTab.test.tsx
npx vitest run src/ui/contexts/SessionContext.test.tsx
npx vitest run src/i18n/mustTranslateKeys.test.ts
```

Then run repository verification:

```bash
npm run format
npm run lint
npm run build
npm run typecheck
```

## Manual scenario

1. Start the development CLI with a streaming model.
2. Submit a prompt that produces a multi-token response.
3. Open `/stats`.
4. In the Session tab, confirm Generation Metrics shows the latest model,
   TTFT, generation time, output tokens, and TPS.
5. Submit a second prompt and reopen `/stats`.
6. Confirm the latest-request fields changed and session request count,
   average TTFT, and session TPS include both timed requests.
7. Run `/stats` through a non-interactive command surface and confirm the same
   metrics appear as text.

## Regression checks

- Opening `/stats` before any streamed response does not show an empty
  Generation Metrics section.
- A non-streaming response does not invent TTFT or TPS.
- A stream with no user-visible content does not create a timing sample.
- A zero generation duration displays TPS as unavailable instead of Infinity.
- Internal prompts do not replace the latest user-visible generation sample.
- `/stats daily`, `/stats monthly`, and `/stats export` remain unchanged.

## Baseline status

A released global `qwen` executable was not available in this environment, so
the before-change manual scenario could not be run. The existing source and
tests establish the baseline: TTFT is emitted to tracing, while `/stats` has no
generation-timing section.
