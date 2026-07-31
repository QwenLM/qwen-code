package com.alibaba.acp.sdk.protocol.domain.content.embedded;

public class TextResourceContents extends ResourceContent {
    private String text;

    public String getText() {
        return text;
    }

    public void setText(String text) {
        this.text = text;
    }
}
