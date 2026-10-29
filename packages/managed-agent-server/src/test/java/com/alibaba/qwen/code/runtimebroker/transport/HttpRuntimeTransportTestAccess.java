package com.alibaba.qwen.code.runtimebroker.transport;

import java.net.http.HttpClient;
import java.time.Duration;

public final class HttpRuntimeTransportTestAccess {
    private HttpRuntimeTransportTestAccess() {
    }

    public static HttpRuntimeTransport create(HttpClient client, Duration timeout) {
        return new HttpRuntimeTransport(client, timeout);
    }
}
