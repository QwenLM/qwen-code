package com.alibaba.qwen.code.managedagent.session;

import java.util.Set;

/**
 * The Harness 409 codes that heal on their own: a fenced predecessor's
 * writer lease lapses, a busy or briefly unavailable Workspace frees up,
 * a closing Session finishes. A public route crosses them as the
 * retryable 503, never as a conflict a client reads as final.
 *
 * <p>{@code hosted_session_blocked} is deliberately excluded: a recovery
 * block can lift, but the cleanup-blocked paths may never do so, so a
 * retry cannot be promised. The scanner still re-drives this code after a
 * refused fire; the public route does not promise the same. Every other
 * 409 stays a conflict for the same reason.
 */
public final class HarnessConflictCodes {
    private static final Set<String> TRANSIENT = Set.of(
            "managed_session_writer_conflict", "workspace_busy",
            "workspace_unavailable", "hosted_session_closing");

    public static boolean isTransient(String code) {
        return code != null && TRANSIENT.contains(code);
    }

    private HarnessConflictCodes() {
    }
}
