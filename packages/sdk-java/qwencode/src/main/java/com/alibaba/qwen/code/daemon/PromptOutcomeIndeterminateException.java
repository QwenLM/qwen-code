package com.alibaba.qwen.code.daemon;

/** The SDK cannot prove whether or how the admitted prompt ended. */
public class PromptOutcomeIndeterminateException extends DaemonException {
    private final String partialText;

    PromptOutcomeIndeterminateException(String message, String partialText) {
        super(message);
        this.partialText = partialText;
    }

    PromptOutcomeIndeterminateException(String message, Throwable cause, String partialText) {
        super(message, cause);
        this.partialText = partialText;
    }

    public String getPartialText() {
        return partialText;
    }

    public boolean hasIncompletePartialText() {
        return !partialText.isEmpty();
    }
}
