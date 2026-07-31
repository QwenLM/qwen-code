package com.alibaba.acp.sdk.protocol.jsonrpc;

public class Message extends Meta {
    String jsonrpc = "2.0";
    Object id;

    public String getJsonrpc() {
        return jsonrpc;
    }

    public void setJsonrpc(String jsonrpc) {
        this.jsonrpc = jsonrpc;
    }

    public Object getId() {
        return id;
    }

    public void setId(Object id) {
        this.id = id;
    }
}
