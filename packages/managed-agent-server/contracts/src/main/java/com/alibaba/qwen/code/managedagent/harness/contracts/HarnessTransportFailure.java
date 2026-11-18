package com.alibaba.qwen.code.managedagent.harness.contracts;

public class HarnessTransportFailure extends HarnessFailure {
    public HarnessTransportFailure(String message, Throwable cause) {
        super(message, cause);
    }
}
