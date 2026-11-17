package com.alibaba.qwen.code.managedagent.channel;

import org.apache.commons.codec.digest.DigestUtils;

import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * The Java mirror of the TS PR-watch construction contract
 * (packages/core/src/managed-runtime/managed-pr-watch-operations.ts): the
 * same sha256 over the same NUL-joined identity tuple, byte for byte, so a
 * transition derives one input id across the control plane and the Harness.
 * The shared fixture pins the parity (PrWatchOperationsParityTest).
 */
public final class PrWatchOperations {
    /** The source of every PR-watch input, as the wake scheduler admits it. */
    public static final String PR_EVENT_INPUT_SOURCE = "pr_event";

    /** The minimal slice-1 transition set (state_change is deferred). */
    public static final List<String> PR_WATCH_TRANSITIONS =
            List.of("ci_failure", "merge_conflict", "head_change");

    /** Number.MAX_SAFE_INTEGER: the TS contract's positive-integer bound. */
    private static final long MAX_SAFE_INTEGER = 9007199254740991L;
    private static final String SEPARATOR = Character.toString((char) 0);

    private PrWatchOperations() {
    }

    public static boolean isPrWatchTransition(String value) {
        return PR_WATCH_TRANSITIONS.contains(value);
    }

    /**
     * The identity of one watched-PR transition occurrence; a redelivery of
     * the same occurrence derives the same id. The episode is the adapter's
     * durable per-PR occurrence counter and joins LAST: a legitimate
     * recurrence (dirty-clean-dirty on one head, head A-B-A) is a new episode
     * and must derive a new input id, never dedupe into the first admission.
     */
    public static String prWatchInputId(String tenantId,
            String channelInstanceId, String owner, String repo,
            long prNumber, String transition, String headSha, long episode) {
        return "prw-" + DigestUtils.sha256Hex(String.join(SEPARATOR,
                identity(tenantId, "tenantId"),
                identity(channelInstanceId, "channelInstanceId"),
                identity(owner, "owner"),
                identity(repo, "repo"),
                Long.toString(positive(prNumber, "prNumber")),
                identity(transition, "transition"),
                identity(headSha, "headSha"),
                Long.toString(positive(episode, "episode")))
                .getBytes(StandardCharsets.UTF_8)) + ":input";
    }

    /** The stable identity of a PR-watch binding (one per PR per channel). */
    public static String prWatchBindingId(String tenantId,
            String channelInstanceId, String owner, String repo,
            long prNumber) {
        return "prb-" + DigestUtils.sha256Hex(String.join(SEPARATOR,
                identity(tenantId, "tenantId"),
                identity(channelInstanceId, "channelInstanceId"),
                identity(owner, "owner"),
                identity(repo, "repo"),
                Long.toString(positive(prNumber, "prNumber")))
                .getBytes(StandardCharsets.UTF_8));
    }

    private static String identity(String value, String label) {
        if (value == null || value.isEmpty() || value.indexOf(0) >= 0) {
            throw new IllegalArgumentException(
                    label + " must be non-empty and hold no NUL.");
        }
        return value;
    }

    private static long positive(long value, String label) {
        if (value < 1 || value > MAX_SAFE_INTEGER) {
            throw new IllegalArgumentException(
                    label + " must be a positive safe integer.");
        }
        return value;
    }
}
