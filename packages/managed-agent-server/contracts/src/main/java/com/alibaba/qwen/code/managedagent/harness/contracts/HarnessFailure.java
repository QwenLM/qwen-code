package com.alibaba.qwen.code.managedagent.harness.contracts;

public class HarnessFailure extends RuntimeException {
    public HarnessFailure(String message) { super(message); }
    public HarnessFailure(String message, Throwable cause) { super(message, cause); }
}
