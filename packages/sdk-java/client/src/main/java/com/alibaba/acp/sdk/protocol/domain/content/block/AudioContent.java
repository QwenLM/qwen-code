package com.alibaba.acp.sdk.protocol.domain.content.block;

import com.alibaba.fastjson2.annotation.JSONType;

@JSONType(typeKey = "type", typeName = "audio")
public class AudioContent extends ContentBlock {
    private String data;
    private String mimeType;
    private Annotations annotations;

    public AudioContent() {
        super();
        this.type = "audio";
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

    public Annotations getAnnotations() {
        return annotations;
    }

    public void setAnnotations(Annotations annotations) {
        this.annotations = annotations;
    }
}
