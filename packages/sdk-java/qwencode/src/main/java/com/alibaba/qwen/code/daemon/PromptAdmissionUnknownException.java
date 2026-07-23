package com.alibaba.qwen.code.daemon;

/** Prompt admission may have succeeded, so reposting could execute it twice. */
public final class PromptAdmissionUnknownException extends MutationOutcomeUnknownException {
    PromptAdmissionUnknownException(Throwable cause) {
        super("POST /session/:id/prompt", cause);
    }

    PromptAdmissionUnknownException(String message) {
        super("POST /session/:id/prompt", new DaemonProtocolException(message));
    }
}
