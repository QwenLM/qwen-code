package com.alibaba.acp.sdk.protocol.domain.content.block;

import com.alibaba.fastjson2.annotation.JSONType;

@JSONType(typeKey = "type", typeName = "resource_link")
public class ResourceLink extends ContentBlock {
    private String name;
    private String title;
    private String uri;
    private String description;
    private String mimeType;
    private Annotations annotations;
    private Long size;

    public ResourceLink() {
        super();
        this.type = "resource_link";
    }

    // Getters and setters
    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getUri() {
        return uri;
    }

    public void setUri(String uri) {
        this.uri = uri;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
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

    public Long getSize() {
        return size;
    }

    public void setSize(Long size) {
        this.size = size;
    }
}
