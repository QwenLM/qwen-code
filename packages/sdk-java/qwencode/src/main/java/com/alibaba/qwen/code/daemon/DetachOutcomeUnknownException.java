package com.alibaba.qwen.code.daemon;

/** Detach may have succeeded, and close will not issue another detach. */
public final class DetachOutcomeUnknownException extends MutationOutcomeUnknownException {
    DetachOutcomeUnknownException(Throwable cause) {
        super("POST /session/:id/detach", cause);
    }
}
