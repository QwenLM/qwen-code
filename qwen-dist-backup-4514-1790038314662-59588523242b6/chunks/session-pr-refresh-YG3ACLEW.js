// Force strict mode and setup for ESM
"use strict";
import {
  AONE_MAX_MR_VIEW_CALLS_PER_RUN,
  DaemonDrainingError,
  createWorkspaceRuntimeSessionService,
  defaultAoneMrBackend,
  invalidateWorkspaceSessionListCache,
  isAoneDetailUrlForRepo,
  resolveAoneWorkspaceRepo
} from "./chunk-XG5GKKJ7.js";
import "./chunk-OHU2H5CS.js";
import "./chunk-4VQBQLIZ.js";
import "./chunk-N4QWUPDM.js";
import "./chunk-LAUEEBDL.js";
import "./chunk-UH6N3LO7.js";
import "./chunk-ZEZKIS2K.js";
import "./chunk-OIBUG24X.js";
import "./chunk-4JRM2BSM.js";
import "./chunk-7RZUXNH6.js";
import "./chunk-KWYTSSTJ.js";
import "./chunk-WCCLLK7X.js";
import "./chunk-OCPBI7J5.js";
import "./chunk-YYNEF4AU.js";
import "./chunk-LYD3T3H7.js";
import "./chunk-SIUR4U2P.js";
import "./chunk-RN6A53UJ.js";
import "./chunk-YXHY6BKS.js";
import "./chunk-6PLDPT2C.js";
import "./chunk-UDG5EZJI.js";
import "./chunk-M5GB774H.js";
import "./chunk-3VUENPWF.js";
import "./chunk-IJOS26LH.js";
import "./chunk-47GVX3K4.js";
import "./chunk-GELRJXE2.js";
import "./chunk-32CM56LO.js";
import "./chunk-MC2RYJMU.js";
import "./chunk-LJZSMWOH.js";
import "./chunk-DJLCK66M.js";
import "./chunk-M5YIHMXP.js";
import "./chunk-7MEBNX4M.js";
import "./chunk-PWRMILYW.js";
import "./chunk-LAE6RY3L.js";
import "./chunk-FHWIBVQQ.js";
import "./chunk-FXPP7VLM.js";
import "./chunk-7PQ65Z5F.js";
import "./chunk-ZPJWUGCS.js";
import "./chunk-O4A2B6V2.js";
import "./chunk-CAAUC2LP.js";
import "./chunk-SQRZJD25.js";
import "./chunk-NCXNBDGJ.js";
import "./chunk-DJYHML3Y.js";
import "./chunk-HQI463JG.js";
import "./chunk-V2XJJTAB.js";
import "./chunk-DB5RX7EU.js";
import "./chunk-UXEI7POA.js";
import "./chunk-SLHYLVRW.js";
import "./chunk-YDERQ7ZV.js";
import "./chunk-PU756QJZ.js";
import "./chunk-RSFNJ6UU.js";
import "./chunk-JYGESWZM.js";
import "./chunk-TFDCK56Y.js";
import "./chunk-FTKXJMQV.js";
import "./chunk-S5BHLTHK.js";
import "./chunk-KSEKRQJO.js";
import {
  fetchGitHubPullRequestIssues,
  fetchGitHubPullRequests,
  readSessionPrs,
  updateSessionPrStates
} from "./chunk-MRTRBONQ.js";
import "./chunk-GOFAQQZA.js";
import "./chunk-65I7S4Z3.js";
import "./chunk-HEOH7JZY.js";
import "./chunk-TWPJO254.js";
import "./chunk-CQ35AJ4Z.js";
import "./chunk-4YS7RMCB.js";
import "./chunk-PQQV3OBW.js";
import "./chunk-ANKISCKU.js";
import "./chunk-4SZ2636R.js";
import "./chunk-5EZRLTLQ.js";
import "./chunk-QHWCP53L.js";
import "./chunk-C4FISGDN.js";
import "./chunk-O6GEWCJA.js";
import "./chunk-KS6F6LZQ.js";
import "./chunk-6PVPNMXU.js";
import "./chunk-OB57Y2WH.js";
import "./chunk-IMV5DBIP.js";
import "./chunk-IWMYX5LB.js";
import "./chunk-QJNDUTOL.js";
import "./chunk-QPTE6BKL.js";
import "./chunk-U6H3XTFA.js";
import "./chunk-ACHCT36C.js";
import "./chunk-CHEIIBT3.js";
import "./chunk-GHG4PQY2.js";
import "./chunk-YVYK3JYU.js";
import "./chunk-Q5N5NEVT.js";
import "./chunk-ADN5KESB.js";
import "./chunk-SK3RZOPS.js";
import "./chunk-EVZT24AF.js";
import "./chunk-ELRMZTPF.js";
import "./chunk-B5WYAQ4I.js";
import "./chunk-JX6XHPTX.js";
import "./chunk-6C3D7BKK.js";
import "./chunk-ZAQM5T2X.js";
import "./chunk-MNU36NGH.js";
import "./chunk-B3HGO6BB.js";
import "./chunk-AUFTA63J.js";
import "./chunk-SATGWSS6.js";
import "./chunk-MLXTMF7H.js";
import "./chunk-BQMSZSG6.js";
import "./chunk-VNOVK4I7.js";
import "./chunk-WFNEY5G7.js";
import "./chunk-5FHOPPLZ.js";
import "./chunk-S6LOFUVP.js";
import "./chunk-BKVPLSEI.js";
import "./chunk-WNM6BA7E.js";
import "./chunk-S7UQ3V2H.js";
import "./chunk-QE36VXWP.js";
import "./chunk-2A6RZKP2.js";
import "./chunk-WDVSRQIQ.js";
import "./chunk-GXNXX7A2.js";
import "./chunk-IITTKFWM.js";
import "./chunk-Z72PLR74.js";
import "./chunk-NUQ4GK5I.js";
import "./chunk-KP2FHIFR.js";
import "./chunk-TLS6QN2S.js";
import "./chunk-6DB6UHY3.js";
import "./chunk-NAVJD2PQ.js";
import "./chunk-KKPIFWTZ.js";
import "./chunk-NFC4WTY2.js";
import "./chunk-YSD6IY6F.js";
import "./chunk-DJ2GSRLV.js";
import "./chunk-MS4SXNJ6.js";
import "./chunk-GVTAFLWB.js";
import "./chunk-KKGSJZWK.js";
import "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import "./chunk-25FMWESU.js";
import "./chunk-CFMZLE3L.js";
import "./chunk-43QUA4MC.js";
import "./chunk-WZAD4ZNJ.js";
import "./chunk-EKBQJ627.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-HHJLM3WQ.js";
import "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import "./chunk-ZRQGTRHA.js";
import "./chunk-VPGRGNNH.js";
import "./chunk-ERIBG3BX.js";
import "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import "./chunk-7FA2II6K.js";
import "./chunk-UKMWZ5NS.js";
import "./chunk-75DOP5OR.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import "./chunk-MATEIJZF.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/server/session-pr-refresh.ts
init_esbuild_shims();
import { existsSync } from "node:fs";
var DEFAULT_SESSION_PR_REFRESH_INTERVAL_MS = 5 * 60 * 1e3;
var FIRST_RUN_DELAY_MS = 6e4;
var AONE_SWEEP_VIEW_BUDGET_MS = 6e4;
function pullRequestKey(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return void 0;
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|\.diff$|\.patch$|$)/.exec(
    parsed.pathname
  );
  if (!match) return void 0;
  const host = parsed.hostname.replace(/^www\./, "");
  return {
    repo: `${host}/${match[1]}/${match[2]}`.toLowerCase(),
    number: Number(match[3])
  };
}
__name(pullRequestKey, "pullRequestKey");
function samePullRequest(left, right) {
  const a = pullRequestKey(left);
  const b = pullRequestKey(right);
  return a !== void 0 && b !== void 0 && a.repo === b.repo && a.number === b.number;
}
__name(samePullRequest, "samePullRequest");
function resolveSessionPrRefreshIntervalMs(env) {
  const raw = env["QWEN_SESSION_PR_REFRESH_MINUTES"];
  if (raw === void 0 || raw.trim() === "") {
    return DEFAULT_SESSION_PR_REFRESH_INTERVAL_MS;
  }
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return DEFAULT_SESSION_PR_REFRESH_INTERVAL_MS;
  }
  if (minutes === 0) return void 0;
  if (minutes < 1) return DEFAULT_SESSION_PR_REFRESH_INTERVAL_MS;
  const ms = minutes * 6e4;
  return ms <= 2 ** 31 - 1 ? ms : DEFAULT_SESSION_PR_REFRESH_INTERVAL_MS;
}
__name(resolveSessionPrRefreshIntervalMs, "resolveSessionPrRefreshIntervalMs");
async function refreshWorkspaceSessionPrStates(runtime, fetchPullRequests = fetchGitHubPullRequests, options = {}) {
  const assertGenerationOpen = /* @__PURE__ */ __name(() => runtime.generationGuard?.assertOpen(), "assertGenerationOpen");
  const sessionService = createWorkspaceRuntimeSessionService(runtime);
  const pendingNumbers = [];
  let scanned = 0;
  for (const archiveState of ["active", "archived"]) {
    for (const sessionId of sessionService.listSessionIdsWithPrSidecar(
      archiveState
    )) {
      if (!await sessionService.sessionPrSidecarBelongsToCurrentProject(
        sessionId,
        archiveState
      )) {
        continue;
      }
      const prPath = sessionService.getPrSessionPathForArchiveState(
        sessionId,
        archiveState
      );
      let prs;
      try {
        prs = await readSessionPrs(prPath);
      } catch {
        continue;
      }
      if (!prs) continue;
      scanned += 1;
      const pending = prs.filter(
        // Only merged is terminal: closed PRs can be reopened, so they
        // keep participating in the sweep.
        (p) => p.state !== "merged"
      );
      const issueEntries = prs.filter((p) => p.state !== "merged" || p.issues === void 0).map(({ number, url, state }) => ({
        number,
        url,
        merged: state === "merged"
      }));
      if (pending.length > 0 || issueEntries.length > 0) {
        const urls = /* @__PURE__ */ new Map();
        for (const entry of pending) {
          const known = urls.get(entry.number);
          if (known) known.push(entry.url);
          else urls.set(entry.number, [entry.url]);
        }
        pendingNumbers.push({
          sessionId,
          prPath,
          numbers: pending.map((p) => p.number),
          urls,
          issueEntries
        });
      }
    }
  }
  if (pendingNumbers.length === 0) return { scanned, updated: 0 };
  assertGenerationOpen();
  const numberToFetch = /* @__PURE__ */ new Map();
  let convergeMerged = false;
  let repoKey;
  const isForeign = /* @__PURE__ */ __name((url) => repoKey !== void 0 && pullRequestKey(url)?.repo !== repoKey, "isForeign");
  const aoneRepo = await resolveAoneWorkspaceRepo(
    runtime.workspaceCwd,
    runtime.env.effectiveEnv
  );
  let aoneConsumed;
  if (aoneRepo) {
    const refreshable = /* @__PURE__ */ new Set();
    for (const target of pendingNumbers) {
      for (const [number, urls] of target.urls) {
        if (refreshable.has(number)) continue;
        if (urls.some(
          (url) => isAoneDetailUrlForRepo(aoneRepo.repoPath, number, url)
        )) {
          refreshable.add(number);
        }
      }
    }
    const backend = options.aoneBackend ?? defaultAoneMrBackend;
    const all = [
      ...new Set(pendingNumbers.flatMap((target) => target.numbers))
    ].filter((number) => refreshable.has(number));
    const start = all.length === 0 ? 0 : (options.sweepStart ?? 0) % all.length;
    const unique = [...all.slice(start), ...all.slice(0, start)].slice(
      0,
      AONE_MAX_MR_VIEW_CALLS_PER_RUN
    );
    const now = options.now ?? Date.now;
    const deadline = now() + AONE_SWEEP_VIEW_BUDGET_MS;
    let consumed = 0;
    for (const number of unique) {
      if (now() > deadline) break;
      consumed += 1;
      try {
        const view = await backend.view(aoneRepo.repoPath, number);
        numberToFetch.set(view.number, { state: view.state, url: view.url });
      } catch {
      }
    }
    aoneConsumed = consumed;
    convergeMerged = true;
  } else {
    if (pendingNumbers.some((target) => target.numbers.length > 0)) {
      const result = await fetchPullRequests(
        runtime.workspaceCwd,
        runtime.env.effectiveEnv,
        { state: "all", limit: 500, slim: true }
      );
      if (result.kind === "ok") {
        for (const pr of result.pullRequests) {
          numberToFetch.set(pr.number, {
            state: pr.state === "draft" ? "open" : pr.state,
            url: pr.url
          });
        }
        const sample = result.pullRequests[0]?.url;
        if (sample !== void 0) repoKey = pullRequestKey(sample)?.repo;
      }
    }
    const issueNumbers = [
      ...new Set(
        pendingNumbers.flatMap(
          (target) => target.issueEntries.filter((entry) => !isForeign(entry.url)).map((entry) => entry.number)
        )
      )
    ];
    if (issueNumbers.length > 0) {
      assertGenerationOpen();
      const issuesResult = await fetchGitHubPullRequestIssues(
        runtime.workspaceCwd,
        runtime.env.effectiveEnv,
        issueNumbers
      );
      if (issuesResult.kind === "ok") {
        convergeMerged = true;
        for (const [number, { url, issues }] of issuesResult.pullRequests) {
          numberToFetch.set(number, {
            ...numberToFetch.get(number) ?? { url },
            issues
          });
        }
      } else if (issuesResult.kind === "cli_unavailable" || issuesResult.kind === "not_a_repo" || issuesResult.kind === "repo_unresolved") {
        convergeMerged = true;
      }
    }
  }
  let updated = 0;
  for (const target of pendingNumbers) {
    const states = /* @__PURE__ */ new Map();
    for (const number of target.numbers) {
      const fetched = numberToFetch.get(number);
      if (fetched !== void 0) states.set(number, fetched);
    }
    for (const entry of target.issueEntries) {
      const fetched = numberToFetch.get(entry.number);
      if (fetched !== void 0 && samePullRequest(fetched.url, entry.url)) {
        states.set(entry.number, { ...fetched, url: entry.url });
      } else if (entry.merged && (convergeMerged || isForeign(entry.url))) {
        states.set(entry.number, { url: entry.url, issues: [] });
      }
    }
    if (states.size === 0) continue;
    const commit = /* @__PURE__ */ __name(() => updateSessionPrStates(target.prPath, states, {
      assertCanCommit: /* @__PURE__ */ __name(() => {
        assertGenerationOpen();
        if (!existsSync(target.prPath)) {
          throw new Error(
            `session PR sidecar vanished during refresh: ${target.prPath}`
          );
        }
      }, "assertCanCommit")
    }), "commit");
    try {
      updated += await (options.archiveCoordinator ? options.archiveCoordinator.runSharedMany([target.sessionId], commit) : commit());
    } catch (error) {
      if (error instanceof DaemonDrainingError) throw error;
    }
  }
  if (updated > 0) {
    assertGenerationOpen();
    invalidateWorkspaceSessionListCache({
      runtimeBaseDir: runtime.sessionRuntimeBaseDir,
      workspaceCwd: runtime.workspaceCwd,
      archiveStates: ["active", "archived"]
    });
    runtime.bridge.markSessionCatalogChanged();
  }
  return { scanned, updated, aoneConsumed };
}
__name(refreshWorkspaceSessionPrStates, "refreshWorkspaceSessionPrStates");
function startSessionPrRefreshTimer(deps) {
  const intervalMs = resolveSessionPrRefreshIntervalMs(deps.env ?? process.env);
  if (intervalMs === void 0) return void 0;
  const aoneSweepOffsets = /* @__PURE__ */ new Map();
  let running = false;
  const tick = /* @__PURE__ */ __name(async () => {
    if (running) return;
    running = true;
    try {
      const archiveCoordinator = deps.getArchiveCoordinator?.();
      const live = deps.workspaceRegistry.listAll();
      for (const runtime of live) {
        if (!runtime.trusted) continue;
        const sweepStart = aoneSweepOffsets.get(runtime.workspaceCwd) ?? 0;
        try {
          const result = await refreshWorkspaceSessionPrStates(
            runtime,
            void 0,
            {
              archiveCoordinator,
              sweepStart,
              aoneBackend: deps.aoneBackend,
              now: deps.now
            }
          );
          if (result.aoneConsumed !== void 0) {
            aoneSweepOffsets.set(
              runtime.workspaceCwd,
              sweepStart + result.aoneConsumed
            );
          }
        } catch (error) {
          if (error instanceof DaemonDrainingError) return;
        }
      }
      const liveCwds = new Set(live.map((r) => r.workspaceCwd));
      for (const cwd of [...aoneSweepOffsets.keys()]) {
        if (!liveCwds.has(cwd)) aoneSweepOffsets.delete(cwd);
      }
    } finally {
      running = false;
    }
  }, "tick");
  const first = setTimeout(() => void tick(), FIRST_RUN_DELAY_MS);
  first.unref();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return {
    dispose() {
      clearTimeout(first);
      clearInterval(timer);
    }
  };
}
__name(startSessionPrRefreshTimer, "startSessionPrRefreshTimer");
export {
  AONE_SWEEP_VIEW_BUDGET_MS,
  DEFAULT_SESSION_PR_REFRESH_INTERVAL_MS,
  refreshWorkspaceSessionPrStates,
  resolveSessionPrRefreshIntervalMs,
  startSessionPrRefreshTimer
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
