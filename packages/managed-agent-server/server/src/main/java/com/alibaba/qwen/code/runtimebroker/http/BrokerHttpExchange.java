package com.alibaba.qwen.code.runtimebroker.http;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;

interface BrokerHttpExchange {
    URI getRequestURI();

    String getRequestMethod();

    String getRequestHeader(String name);

    void setResponseHeader(String name, String value);

    InputStream getRequestBody() throws IOException;

    OutputStream getResponseBody() throws IOException;

    void sendResponseHeaders(int status, long contentLength) throws IOException;

    void close();
}
