package com.alibaba.qwen.code.managedagent.harness.contracts;

import java.util.Map;

public final class HarnessHttpFailure extends HarnessFailure {
    private final int statusCode;
    private final String responseBody;
    private final Map<String, String> bodyFields;

    public HarnessHttpFailure(String message, Throwable cause, int statusCode, String responseBody, Map<String, String> bodyFields) {
        super(message, cause);
        this.statusCode = statusCode;
        this.responseBody = responseBody;
        this.bodyFields = Map.copyOf(bodyFields);
    }

    public int getStatusCode() { return statusCode; }

    public String getResponseBody() { return responseBody; }

    public String getErrorCode() { return getBodyField("code"); }

    public String getBodyField(String name) { return bodyFields.get(name); }
}
