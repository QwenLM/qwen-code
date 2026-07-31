package com.alibaba.acp.sdk.protocol.domain.content.embedded;

import com.alibaba.acp.sdk.protocol.domain.content.block.Annotations;
import com.alibaba.acp.sdk.protocol.domain.content.block.ContentBlock;
import com.alibaba.fastjson2.annotation.JSONType;

@JSONType(typeKey = "type", typeName = "resource")
public class EmbeddedResource extends ContentBlock {
    private ResourceContent resource;  // This could be TextResourceContents or BlobResourceContents
    private Annotations annotations;

    public EmbeddedResource() {
        super();
        this.type = "resource";
    }

    public ResourceContent getResource() {
        return resource;
    }

    public void setResource(ResourceContent resource) {
        this.resource = resource;
    }

    public Annotations getAnnotations() {
        return annotations;
    }

    public void setAnnotations(Annotations annotations) {
        this.annotations = annotations;
    }
}
