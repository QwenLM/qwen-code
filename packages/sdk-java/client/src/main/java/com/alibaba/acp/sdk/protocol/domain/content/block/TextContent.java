package com.alibaba.acp.sdk.protocol.domain.content.block;

import com.alibaba.fastjson2.annotation.JSONType;

@JSONType(typeKey = "type", typeName = "text")
public class TextContent extends ContentBlock {
    private String text;
    private Annotations annotations;

    public TextContent() {
        super();
        this.type = "text";
    }

    public TextContent(String text) {
        this();
        this.text = text;
    }

    // Getters and setters
    public String getText() {
        return text;
    }

    public void setText(String text) {
        this.text = text;
    }

    public Annotations getAnnotations() {
        return annotations;
    }

    public void setAnnotations(Annotations annotations) {
        this.annotations = annotations;
    }
}
