package com.alibaba.qwen.code.daemon;

import java.util.Map;

/** A received non-success HTTP response from the daemon or an intermediary. */
public final class DaemonHttpException extends DaemonException {
    private final int statusCode;
    private final String responseBody;

    DaemonHttpException(String operation, int statusCode, String responseBody) {
        super(operation + " failed with HTTP " + statusCode
                + (responseBody.isEmpty() ? "" : ": " + responseBody));
        this.statusCode = statusCode;
        this.responseBody = responseBody;
    }

    public int getStatusCode() {
        return statusCode;
    }

    public String getResponseBody() {
        return responseBody;
    }

    /** The JSON error body's {@code code} field, or null when the body is
     * not a JSON object carrying a string {@code code}. Callers must stay
     * code-blind except where a contract names the codes it relies on. */
    public String getErrorCode() {
        return getBodyField("code");
    }

    /** A string field of the JSON error body, or null when absent or not a
     * string. */
    public String getBodyField(String name) {
        if (responseBody == null || responseBody.isEmpty()) {
            return null;
        }
        Map<String, Object> body;
        try {
            body = JsonSupport.parseObject(responseBody,
                    "HTTP " + statusCode + " error body");
        } catch (RuntimeException parseFailure) {
            return null;
        }
        Object value = body.get(name);
        return value instanceof String ? (String) value : null;
    }
}
