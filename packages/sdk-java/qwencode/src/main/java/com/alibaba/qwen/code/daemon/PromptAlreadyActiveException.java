package com.alibaba.qwen.code.daemon;

/**
 * A second prompt identity met an already-active turn: either a local veto
 * (no status), or the Hosted Harness's definitive refusal on the wire, which
 * carries the HTTP status and the machine-readable refusal code.
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
