package com.alibaba.qwen.code.daemon;

/**
 * The Hosted Harness deliberately refused to open a Session and named the
 * refusal with a machine-readable code on the wire. A named refusal is
 * fail-closed — the Harness cleaned up the failed open before answering — so
 * unlike an ambiguous failure the outcome is known and the code is safe to
 * record and surface (for example a journal this build cannot read during a
 * mixed-version takeover).
 */
public final class HarnessSessionRefusedException extends DaemonException {
    private final int statusCode;
    private final String code;

    HarnessSessionRefusedException(String operation, int statusCode,
            String code, Throwable cause) {
        super(operation + " was refused with HTTP " + statusCode + ": "
                + code, cause);
        this.statusCode = statusCode;
        this.code = code;
    }

    public int getStatusCode() {
        return statusCode;
    }

    public String getCode() {
        return code;
    }
}
