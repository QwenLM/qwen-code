package com.alibaba.qwen.code.runtimebroker;

/**
 * The outcome of admitting a terminal hold. {@code created} distinguishes a
 * hold this attach newly admitted from one a reconnect reused: only a newly
 * created hold may be discharged when the worker attach fails, because a
 * reused hold still protects a live PTY that this attempt did not start.
 */
public record TerminalHoldAdmission(ToolExecutionRecord hold, boolean created) {
}
