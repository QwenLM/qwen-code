package com.alibaba.qwen.code.daemon;

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
}
