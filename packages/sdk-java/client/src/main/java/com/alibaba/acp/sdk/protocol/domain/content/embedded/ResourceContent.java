package com.alibaba.acp.sdk.protocol.domain.content.embedded;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.fastjson2.annotation.JSONType;

@JSONType(deserializer = ResourceContentDeserializer.class)
public class ResourceContent extends Meta {
    protected String mimeType;
    protected String uri;

    public String getMimeType() {
        return mimeType;
    }

    public void setMimeType(String mimeType) {
        this.mimeType = mimeType;
    }

    public String getUri() {
        return uri;
    }

    public void setUri(String uri) {
        this.uri = uri;
    }
}
