package com.alibaba.qwen.code.daemon;

/** The daemon emitted a reliable matching turn_error terminal. */
public final class PromptTurnException extends DaemonException {
    private final PromptTerminal terminal;
    private final String partialText;

    PromptTurnException(PromptTerminal terminal, String partialText) {
        super(terminal.getMessage() == null ? "Prompt turn failed" : terminal.getMessage());
        this.terminal = terminal;
        this.partialText = partialText;
    }

    public PromptTerminal getTerminal() {
        return terminal;
    }

    public String getPartialText() {
        return partialText;
    }
}
