package com.alibaba.qwen.code.managedagent.artifact;

import java.util.Objects;

public final class ToolPublicationStorageException extends RuntimeException {
    public enum Reason {
        ACCESS_DENIED,
        FAILURE
    }

    private final Reason reason;

    public ToolPublicationStorageException(Reason reason, Throwable cause) {
        super("Tool publication storage request failed", cause);
        this.reason = Objects.requireNonNull(reason);
    }

    public Reason getReason() {
        return reason;
    }
}
