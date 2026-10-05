package com.alibaba.qwen.code.daemon;

/**
 * Thrown when the Hosted Harness definitively refuses a prompt submission
 * with HTTP 409. The route's 409 vocabulary is wider than a turn conflict —
 * see {@link #getCode()}, which is {@code null} when the response body
 * carried no recognisable code. {@link DaemonSessionClient}'s local veto is
 * the only producer that carries no status; {@link HostedHarnessClient}
 * vetoes a second prompt identity with a bare {@link DaemonException}.
 */
public final class PromptAlreadyActiveException extends DaemonException {
    private final int statusCode;
    private final String code;

    PromptAlreadyActiveException() {
        super("DaemonSessionClient permits only one local prompt at a time");
        this.statusCode = 0;
        this.code = null;
    }

    PromptAlreadyActiveException(String operation, int statusCode,
            String code) {
        super(operation + " was refused with HTTP " + statusCode
                + (code == null ? "" : ": " + code));
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
