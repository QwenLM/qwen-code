package com.alibaba.qwen.code.cli.protocol.message.assistant.block;

import com.alibaba.fastjson2.annotation.JSONField;

/**
 * Represents an annotation for a content block.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class Annotation {
    /**
     * The annotation type.
     */
    @JSONField(name = "type")
    private String type;

    /**
     * The annotation value.
     */
    @JSONField(name = "value")
    private String value;

    /**
     * Gets the annotation type.
     *
     * @return The annotation type
     */
    public String getType() {
        return type;
    }

    /**
     * Sets the annotation type.
     *
     * @param type The annotation type
     */
    public void setType(String type) {
        this.type = type;
    }

    /**
     * Gets the annotation value.
     *
     * @return The annotation value
     */
    public String getValue() {
        return value;
    }

    /**
     * Sets the annotation value.
     *
     * @param value The annotation value
     */
    public void setValue(String value) {
        this.value = value;
    }
}
