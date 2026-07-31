package com.alibaba.acp.sdk.protocol.domain.session.update;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

public class UnstructuredCommandInput extends Meta {
    private String hint;

    // Getters and setters
    public String getHint() {
        return hint;
    }

    public void setHint(String hint) {
        this.hint = hint;
    }
}
