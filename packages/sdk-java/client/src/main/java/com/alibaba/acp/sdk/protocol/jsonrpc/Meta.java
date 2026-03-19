package com.alibaba.acp.sdk.protocol.jsonrpc;

import java.util.Map;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONWriter.Feature;
import com.alibaba.fastjson2.annotation.JSONField;

/**
 * Base class for objects that contain metadata.
 *
 * This class provides a generic way to store metadata in the form of key-value pairs
 * that can be included in JSON-RPC messages for additional context or information.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public class Meta {
    @JSONField(name = "_meta")
    Map<String, Object> meta;

    /**
     * Gets the metadata map.
     *
     * @return The metadata map containing key-value pairs
     */
    public Map<String, Object> getMeta() {
        return meta;
    }

    /**
     * Sets the metadata map.
     *
     * @param meta The metadata map containing key-value pairs
     */
    public void setMeta(Map<String, Object> meta) {
        this.meta = meta;
    }

    /**
     * Converts this object to its JSON string representation.
     *
     * @return JSON string representation of this object
     */
    public String toString() {
        return JSON.toJSONString(this, Feature.FieldBased);
    }
}
