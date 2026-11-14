package com.alibaba.qwen.code.managedagent.harness.contracts;

public class HarnessMutationUnknownFailure extends HarnessFailure {
    private final String operation;
    public HarnessMutationUnknownFailure(String message, Throwable cause, String operation) {
        super(message, cause);
        this.operation = operation;
    }
    public String getOperation() { return operation; }
}
