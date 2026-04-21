package com.alibaba.acp.sdk.protocol.domain.content.block;

import com.alibaba.fastjson2.annotation.JSONType;

@JSONType(typeKey = "type", typeName = "image")
public class ImageContent extends ContentBlock {
    private String data;
    private String mimeType;
    private String uri;
    private Annotations annotations;

    public ImageContent() {
        super();
        this.type = "image";
    }

    // Getters and setters
    public String getData() {
        return data;
    }

    public void setData(String data) {
        this.data = data;
    }

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

    public Annotations getAnnotations() {
        return annotations;
    }

    public void setAnnotations(Annotations annotations) {
        this.annotations = annotations;
    }
}
