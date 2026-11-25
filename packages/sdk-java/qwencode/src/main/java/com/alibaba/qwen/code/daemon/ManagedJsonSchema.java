package com.alibaba.qwen.code.daemon;

import java.util.List;
import java.util.Map;

/** JSON Schema for the arguments of a tool in the Managed MCP catalog. */
public final class ManagedJsonSchema extends ManagedJson {
    ManagedJsonSchema(Map<String, Object> json) {
        super(json);
    }

    /** The explicit type keyword, as a list for both its string and array forms. */
    public List<String> getTypes() {
        Object type = json().get("type");
        if (type == null) {
            return List.of();
        }
        if (type instanceof String) {
            return List.of((String) type);
        }
        return List.copyOf(JsonSupport.stringList(json(), "type"));
    }

    /** Tool-defined property names and their raw JSON subschemas. */
    public Map<String, Object> getProperties() {
        Map<String, Object> properties = optionalObject("properties");
        return properties == null ? Map.of() : properties;
    }

    public List<String> getRequired() {
        return json().get("required") == null ? List.of() : List.copyOf(JsonSupport.stringList(json(), "required"));
    }

    public String getDescription() {
        return optionalString("description");
    }

    /** Complete read-only schema, including additional and tool-defined keywords. */
    public Map<String, Object> asJson() {
        return json();
    }
}
