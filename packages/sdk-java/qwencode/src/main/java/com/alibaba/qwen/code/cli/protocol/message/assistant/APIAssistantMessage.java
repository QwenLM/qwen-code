package com.alibaba.qwen.code.cli.protocol.message.assistant;

import java.util.List;

import com.alibaba.fastjson2.annotation.JSONField;
import com.alibaba.qwen.code.cli.protocol.data.Usage;
import com.alibaba.qwen.code.cli.protocol.message.assistant.block.ContentBlock;

/**
 * Represents an API assistant message.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class APIAssistantMessage {
    /**
     * Message ID.
     */
    private String id;
    /**
     * Message type.
     */
    private String type = "message";
    /**
     * Message role.
     */
    private String role = "assistant";
    /**
     * Message model.
     */
    private String model;
    /**
     * Message content.
     */
    private List<ContentBlock<?>> content;

    /**
     * Stop reason.
     */
    @JSONField(name = "stop_reason")
    private String stopReason;
    /**
     * Usage information.
     */
    private Usage usage;

    /**
     * Gets the message ID.
     *
     * @return The message ID
     */
    public String getId() {
        return id;
    }

    /**
     * Sets the message ID.
     *
     * @param id The message ID
     */
    public void setId(String id) {
        this.id = id;
    }

    /**
     * Gets the message type.
     *
     * @return The message type
     */
    public String getType() {
        return type;
    }

    /**
     * Sets the message type.
     *
     * @param type The message type
     */
    public void setType(String type) {
        this.type = type;
    }

    /**
     * Gets the message role.
     *
     * @return The message role
     */
    public String getRole() {
        return role;
    }

    /**
     * Sets the message role.
     *
     * @param role The message role
     */
    public void setRole(String role) {
        this.role = role;
    }

    /**
     * Gets the message model.
     *
     * @return The message model
     */
    public String getModel() {
        return model;
    }

    /**
     * Sets the message model.
     *
     * @param model The message model
     */
    public void setModel(String model) {
        this.model = model;
    }

    /**
     * Gets the stop reason.
     *
     * @return The stop reason
     */
    public String getStopReason() {
        return stopReason;
    }

    /**
     * Sets the stop reason.
     *
     * @param stopReason The stop reason
     */
    public void setStopReason(String stopReason) {
        this.stopReason = stopReason;
    }

    /**
     * Gets the usage information.
     *
     * @return The usage information
     */
    public Usage getUsage() {
        return usage;
    }

    /**
     * Sets the usage information.
     *
     * @param usage The usage information
     */
    public void setUsage(Usage usage) {
        this.usage = usage;
    }

    /**
     * Gets the message content.
     *
     * @return The message content
     */
    public List<ContentBlock<?>> getContent() {
        return content;
    }

    /**
     * Sets the message content.
     *
     * @param content The message content
     */
    public void setContent(List<ContentBlock<?>> content) {
        this.content = content;
    }
}
