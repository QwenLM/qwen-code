#!/usr/bin/env node
// Should this repository keep auto-triggering reviews on this PR?
//
// The review pipeline measures whether a loop is settling and says so; it
// owns no threshold and stops nothing (see issue #9278's governance rule —
// the tool measures, the caller decides). This is the caller's half: OUR
// number, applied to telemetry the pipeline already publishes, deciding only
// whether the AUTOMATIC trigger keeps firing.
//
// What it never does:
//
// - It never blocks an explicit request. The gate that calls this runs only
//   on `opened`/`synchronize`; `@qwen-code /review` and a review_requested
//   go around it entirely. Stopping the treadmill is not refusing to review.
// - It never fails closed. Every doubt — telemetry that will not parse, a
//   round we cannot see, a posture that changed underneath the numbers —
//   continues reviewing. A caller that silences reviews when it cannot read
//   its own evidence is worse than one with no rule at all.
//
// The evidence is the ledger marker each posted review carries. Only two
// fields are read (`round`, `fresh`) plus `floor` to reject a comparison
// across a posture change; the reader is deliberately narrow because it is a
// SECOND reader of a format `parseLedger` owns, and a narrow one that fails
// open cannot drift into a wrong decision — only into "keep reviewing".

/** The default window, and the whole of this module's policy. */
export const DEFAULT_WINDOW = 3;

const OPEN = '<!-- qwen-review-ledger ';
const CLOSE = ' -->';

/**
 * The fields the caller's rule needs, or null when the body carries none.
 *
 * LAST marker, like `parseLedger`: an edited or quote-carrying body can hold
 * more than one, and the newest round describes the current state.
 */
export function readMarker(body) {
  if (typeof body !== 'string') return null;
  const start = body.lastIndexOf(OPEN);
  if (start < 0) return null;
  const end = body.indexOf(CLOSE, start);
  if (end < 0) return null;
  let raw;
  try {
    raw = JSON.parse(body.slice(start + OPEN.length, end));
  } catch {
    return null;
  }
  if (!raw || raw.v !== 1) return null;
  const round = Number.isInteger(raw.round) && raw.round > 0 ? raw.round : null;
  if (round === null) return null;
  // `fresh` is the count the trend is about — the round's FIRST-TIME
  // findings, not its whole output, which only ever rises while an unfixed
  // blocker keeps being re-posted.
  const fresh = Number.isInteger(raw.fresh) && raw.fresh >= 0 ? raw.fresh : null;
  const floor = raw.floor === 'c' || raw.floor === 'o' ? raw.floor : null;
  return { round, fresh, floor };
}

/**
 * Keep auto-triggering, or stop?
 *
 * `bodies` is every review body this account posted on the PR, newest first.
 * Returns `{ stop, reason, evidence }` — `reason` is rendered to the operator
 * and to the PR, so it states the measurement, never a verdict about the work.
 *
 * `evidence.rounds` is present on BOTH answers, oldest first, and is the
 * readable rounds this call actually saw. The caller reads its length to
 * decide whether a stale pause notice could exist at all: a PR with no
 * readable round has never been paused, because a pause needs `window + 1`
 * of them.
 */
export function decideAutoStop(bodies, options = {}) {
  const window = Number.isInteger(options.window) && options.window > 0
    ? options.window
    : DEFAULT_WINDOW;
  const rounds = [];
  const evidence = () => ({ window, rounds: rounds.slice().reverse() });
  const cont = (reason) => ({ stop: false, reason, evidence: evidence() });

  for (const body of Array.isArray(bodies) ? bodies : []) {
    const m = readMarker(body);
    if (m) rounds.push(m);
    if (rounds.length === window + 1) break;
  }

  // Not enough published rounds to see a trend of `window` steps. Absence is
  // unevaluable, never "diverging".
  if (rounds.length < window + 1) {
    return cont(
      `only ${rounds.length} round(s) carry a readable marker; ${window + 1} are needed to see ${window} step(s)`,
    );
  }
  // A round whose marker predates the fresh count cannot be compared.
  if (rounds.some((r) => r.fresh === null)) {
    return cont('a round in the window recorded no first-time count');
  }
  // Rounds must be CONSECUTIVE. A gap means a round we cannot see, and a
  // trend measured across it is a trend over unknown work.
  for (let i = 0; i < rounds.length - 1; i++) {
    if (rounds[i].round !== rounds[i + 1].round + 1) {
      return cont(
        `rounds ${rounds[rounds.length - 1].round}..${rounds[0].round} are not consecutive`,
      );
    }
  }
  // A settled round is the observation the trend exists to find, not a
  // symptom — the same reading the pipeline itself refuses to call divergence.
  if (rounds[0].fresh === 0) {
    return cont('the latest round produced no first-time findings');
  }
  // A posture change is not loop behaviour. Unrecorded floors are not a
  // change; two DIFFERENT recorded ones are.
  const floors = new Set(rounds.map((r) => r.floor).filter((f) => f !== null));
  if (floors.size > 1) {
    return cont('the posting floor changed inside the window');
  }
  // Every step non-shrinking: the loop has not converged in `window` rounds.
  for (let i = 0; i < rounds.length - 1; i++) {
    if (rounds[i].fresh < rounds[i + 1].fresh) {
      return cont(
        `first-time findings fell from ${rounds[i + 1].fresh} to ${rounds[i].fresh} at round ${rounds[i].round}`,
      );
    }
  }
  const counts = rounds
    .slice()
    .reverse()
    .map((r) => `r${r.round}=${r.fresh}`)
    .join(' → ');
  return {
    stop: true,
    reason: `first-time findings did not fall across ${window} consecutive round(s): ${counts}`,
    evidence: evidence(),
  };
}
