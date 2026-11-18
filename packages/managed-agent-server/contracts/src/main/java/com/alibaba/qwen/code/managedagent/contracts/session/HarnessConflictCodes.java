package com.alibaba.qwen.code.managedagent.contracts.session;

import java.util.Set;
import java.util.regex.Pattern;

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

    // Tolerates whitespace around the colon and still matches a body
    // truncated mid-JSON, where a full parse would fail. Error codes are
    // plain identifiers, so the value never carries an escaped quote.
    private static final Pattern BODY_CODE = Pattern.compile(
            "\"code\"\\s*:\\s*\"([^\"]*)\"");

    /** The first {@code code} field named in a Harness error body, or null. */
    public static String bodyCode(String body) {
        if (body == null) {
            return null;
        }
        var matcher = BODY_CODE.matcher(body);
        return matcher.find() ? matcher.group(1) : null;
    }

    private HarnessConflictCodes() {
    }
}
