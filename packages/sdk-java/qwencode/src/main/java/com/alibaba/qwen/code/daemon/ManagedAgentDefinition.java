package com.alibaba.qwen.code.daemon;

import java.util.Map;

/** Public view of one immutable AgentDefinition revision. */
public final class ManagedAgentDefinition extends ManagedJson {
    ManagedAgentDefinition(Map<String, Object> json) {
        super(json);
    }

    public String getId() {
        return string("id");
    }

    public String getObject() {
        return string("object");
    }

    public String getRevision() {
        return string("revision");
    }

    public String getDigest() {
        return string("digest");
    }

    /** Creation time of this revision in Unix epoch milliseconds. */
    public long getCreatedAt() {
        return number("created_at");
    }

    /** Returns application metadata when present. */
    public Map<String, Object> getMetadata() {
        return optionalObject("metadata");
    }
}
