/**
 * Mid-turn cross-session delivery constants.
 *
 * This module must stay dependency-free. The settings schema needs the
 * budget default, and importing it through `peer-messaging.ts` would put a
 * runtime edge from the config import graph into core — which several CLI
 * suites partially mock, breaking them at collection.
 */

/** Rolling window over which the mid-turn peer delivery budget is counted. */
export const PEER_MID_TURN_WINDOW_MS = 5 * 60 * 1000;

/** Envelopes a session may steer into a running turn per window by default. */
export const PEER_MID_TURN_BUDGET_DEFAULT = 3;
