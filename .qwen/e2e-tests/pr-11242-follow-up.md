# PR #11242 review follow-up verification

Baseline: `41d11d116d10bc92b4119418e7cc87a3350b3f95`. Updated stacked base: `2bce3892b40c4f480c08ada6a7f3a79302463833`. Tested on macOS arm64, Node 22, Chrome for Testing 151.0.7922.34 with isolated profiles. The global Qwen CLI predates this relay; its version was checked, then the actual PR sources and built artifacts were used for verification.

## Regression scenarios

| Scenario | Baseline observation | Required result |
| --- | --- | --- |
| Package verification | 3 failures / 420 tests; deleted ensureSocketDirectory import breaks typecheck | Current suite and typecheck pass with prepareSocketDirectory and protocol-v2 hello fixtures |
| Smoke completion verifier | Ping precedes start; debugger conflict does not retry | Start before ping, full discovery window, retry only TAB_DEBUGGER_CONFLICT |
| Crash and re-registration | Duplicate entries close handoff or close a tab twice | Replace stale entry after successful registration, retain created ownership, clean once |
| Chrome tab disappears after crash | Finalization repeatedly fails and retains stale entry | Forget confirmed STALE_TAB; retain other failures for retry |
| Managed Chrome interrupts | SIGINT/SIGTERM orphan the detached browser and profile | Normal exit, both signals and a signal during normal cleanup remove the process group and profile |
| Managed browser discovery | Branded Chrome can be selected despite extension loading restrictions | Prefer Chromium / Chrome for Testing; reject explicit Google Chrome 137+ |
| Page-owned overlay element | Page element is adopted, modified and removed | Independent overlay node; page element survives unchanged |
| Oversized UTF-8 response | Valid 17 MiB response kills the actual native-host process | Bounded operation error, same session and subsequent response work; multibyte length is counted in bytes |
| Tab registration in Chrome extension | Page.setDownloadBehavior is rejected before navigation | Register without modifying browser download policy; existing Page download events still reach Playwright |
| Windows socket fixtures | New generic tests bind filesystem paths | Unique Windows named pipes; Windows execution remains pending |

## Package checks

From the repository root, run `npm run build`, `npm run typecheck` and `npm run bundle`. From `packages/browser-use`, run `npm run test:ci`; from `packages/chrome-extension`, run `npm run test:ci` and `npm run typecheck`. Run ESLint on changed source and test files.

Accepted results: Browser Use 21 files / 510 tests, extension 10 files / 99 tests; full root build, typecheck and bundle; targeted ESLint.

## Actual browser check

Set `QWEN_BROWSER_USE_CHROME` to a supported cached Chrome for Testing executable and execute `node packages/browser-use/dist/scripts/managed-chrome-preflight.js` after the build. The script creates its own profile, Native Messaging registration and local HTTP fixture.

Verify extension identity and protocol; new tab and claim; AI snapshot and action using a returned ref; scrolled 100x50 JPEG clip; trusted pointer/keyboard/input events; local form navigation; same-origin download; History permission; deliverable finalization and reclaim; continued usability after 65 seconds idle; final cleanup. Verify both the temporary profile and browser processes disappear on exit.

The first full run failed at the unsupported Page.setDownloadBehavior call. An independent raw-CDP Chrome extension probe then confirmed that omitting this command and enabling Page still produces matching download-start/completed events and the expected 43-byte local fixture file. The rebuilt managed preflight passed in 72.103 seconds with exit 0 and all checks true, including 65-second idle keepalive. Its temporary profile was removed and all 20 observed descendant processes exited.

## Evidence boundaries

No personal browser profile or account was used. Lifecycle/signal and large-response failure probes execute the actual sources with controlled subprocesses or browser API fixtures; these are distinct from the real managed Chrome preflight. Windows and the full model-driven public SauceDemo flow were not executed.

Real Chrome also accepted exact 31-, 1,000- and 10,000-character tab-group titles and retrieved a seven-day-old history entry with explicit from. The omitted-from 24-hour default is now documented. Metadata-specific budgets remain a pending design decision; published Node REPL version synchronization remains explicitly deferred. PR #11241's separate cross-origin and timeout download issues were not changed.
