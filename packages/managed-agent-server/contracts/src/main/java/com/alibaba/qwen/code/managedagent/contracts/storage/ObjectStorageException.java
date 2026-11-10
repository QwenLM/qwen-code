package com.alibaba.qwen.code.managedagent.contracts.storage;

import java.util.Objects;

public final class ObjectStorageException extends RuntimeException {
    public enum Reason { NOT_FOUND, ALREADY_EXISTS, ACCESS_DENIED, UNAVAILABLE, WRITE_OUTCOME_UNKNOWN }

    private final Reason reason;

    public ObjectStorageException(Reason reason, Throwable cause) {
        super("Object storage request failed: " + Objects.requireNonNull(reason).name(), cause);
        this.reason = reason;
    }

    public Reason reason() {
        return reason;
    }
}
