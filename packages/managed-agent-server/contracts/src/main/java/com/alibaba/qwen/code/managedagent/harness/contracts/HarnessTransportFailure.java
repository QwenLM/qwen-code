package com.alibaba.qwen.code.managedagent.harness.contracts;

public final class HarnessTransportFailure extends HarnessFailure {
    public HarnessTransportFailure(String message, Throwable cause) {
        super(message, cause);
    }
}
