package com.alibaba.qwen.code.daemon;

/** A non-idempotent request may have reached the daemon, so it was not retried. */
public class MutationOutcomeUnknownException extends DaemonException {
    private final String operation;

    MutationOutcomeUnknownException(String operation, Throwable cause) {
        super(operation + " may have reached the daemon; the SDK did not retry it", cause);
        this.operation = operation;
    }

    public String getOperation() {
        return operation;
    }
}
