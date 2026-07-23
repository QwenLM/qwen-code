package com.alibaba.qwen.code.daemon;

/** Complete collected assistant text and its reliable terminal. */
public final class PromptTextResult {
    private final String text;
    private final PromptTerminal terminal;

    PromptTextResult(String text, PromptTerminal terminal) {
        this.text = text;
        this.terminal = terminal;
    }

    public String getText() {
        return text;
    }

    public PromptTerminal getTerminal() {
        return terminal;
    }
}
