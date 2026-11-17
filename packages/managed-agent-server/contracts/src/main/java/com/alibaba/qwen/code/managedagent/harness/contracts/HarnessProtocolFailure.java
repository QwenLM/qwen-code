package com.alibaba.qwen.code.managedagent.harness.contracts;

public final class HarnessProtocolFailure extends HarnessFailure {
    public HarnessProtocolFailure(String message, Throwable cause) {
        super(message, cause);
    }
}
