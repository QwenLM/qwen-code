package com.alibaba.qwen.code.daemon;

/** Text collection stopped before a terminal because its configured cap was exceeded. */
public final class PromptContentLimitException extends PromptOutcomeIndeterminateException {
    private final long maximumBytes;

    PromptContentLimitException(long maximumBytes, String partialText) {
        super("Prompt text exceeded the " + maximumBytes + " byte collection limit", partialText);
        this.maximumBytes = maximumBytes;
    }

    public long getMaximumBytes() {
        return maximumBytes;
    }
}
