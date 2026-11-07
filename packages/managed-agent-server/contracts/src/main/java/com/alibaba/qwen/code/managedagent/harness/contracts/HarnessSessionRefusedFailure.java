package com.alibaba.qwen.code.managedagent.harness.contracts;

public final class HarnessSessionRefusedFailure extends HarnessFailure {
    private final int statusCode;
    private final String code;

    public HarnessSessionRefusedFailure(String message, Throwable cause, int statusCode, String code) {
        super(message, cause);
        this.statusCode = statusCode;
        this.code = code;
    }

    public int getStatusCode() { return statusCode; }

    public String getCode() { return code; }
}
