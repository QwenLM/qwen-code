package com.alibaba.acp.sdk.protocol.jsonrpc;

public class Request<P> extends MethodMessage<P> {
    public Request() {
    }

    public Request(String method, P params) {
        super(method, params);
    }
}
