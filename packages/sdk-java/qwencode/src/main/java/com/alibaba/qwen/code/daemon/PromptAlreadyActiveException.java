package com.alibaba.qwen.code.daemon;

/**
 * Thrown when the Hosted Harness definitively refuses a prompt submission
 * with HTTP 409. The route's 409 vocabulary is wider than a turn conflict —
 * see {@link #getCode()}, which is {@code null} when the response body
 * carried no recognisable code. The wire shape extends {@link
 * DaemonHttpException} so a consumer that matches {@code catch
 * (DaemonHttpException)} still reads the status and the peer's response
 * body (including the machine-readable {@code code} field through
 * {@link #getErrorCode()}); {@link DaemonSessionClient}'s local veto is the
 * only producer that carries no status, and {@link HostedHarnessClient}
 * vetoes a second prompt identity with a bare {@link DaemonException}.
 */
public final class PromptAlreadyActiveException extends DaemonHttpException {
    private final String code;

    PromptAlreadyActiveException() {
        super("DaemonSessionClient permits only one local prompt at a time");
        this.code = null;
    }

    PromptAlreadyActiveException(String operation, int statusCode,
            String responseBody, String code) {
        super(operation, statusCode, responseBody);
        this.code = code;
    }

    public String getCode() {
        return code;
    }
}
