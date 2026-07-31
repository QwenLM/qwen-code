package com.alibaba.acp.sdk.protocol.jsonrpc;

public class Response<R> extends Message {
    R result;
    Error error;

    public Response() {
    }

    public Response(Object id, R result) {
        this.id = id;
        this.result = result;
    }

    public Response(Object id, Error error) {
        this.id = id;
        this.error = error;
    }

    public R getResult() {
        return result;
    }

    public void setResult(R result) {
        this.result = result;
    }

    public Error getError() {
        return error;
    }

    public void setError(Error error) {
        this.error = error;
    }
}
