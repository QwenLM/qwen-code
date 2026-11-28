package com.alibaba.qwen.code.runtimebroker;

import java.util.Set;

/**
 * Dispatch classification produced only from a digest and tool name the
 * caller has already verified against the execution receipt and the parsed
 * payload shape; this class is not a self-contained validator.
 */
public final class VerifiedDispatchPayload {
    private final String digest;
    private final boolean readOnly;

    private VerifiedDispatchPayload(String digest, boolean readOnly) {
        this.digest = digest;
        this.readOnly = readOnly;
    }

    /**
     * Classification from a digest and tool name the caller has already
     * verified against the execution receipt and parsed shape. Avoids a
     * second SHA-256 and JSON parse of the same payload on the dispatch
     * path; the caller owns the verification this factory trusts.
     */
    public static VerifiedDispatchPayload of(String digest, String toolName) {
        return new VerifiedDispatchPayload(digest,
                Set.of("read_file", "glob").contains(toolName));
    }

    public String digest() {
        return digest;
    }

    public boolean readOnly() {
        return readOnly;
    }
}
