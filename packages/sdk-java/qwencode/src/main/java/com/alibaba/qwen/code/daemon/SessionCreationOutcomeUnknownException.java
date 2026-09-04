package com.alibaba.qwen.code.daemon;

/** Session creation may have succeeded, but its response was unavailable. */
public final class SessionCreationOutcomeUnknownException extends MutationOutcomeUnknownException {
    SessionCreationOutcomeUnknownException(Throwable cause) {
        super("POST /session", cause);
    }
}
