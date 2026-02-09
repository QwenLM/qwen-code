package com.alibaba.qwen.code.cli.protocol.message.assistant;

import com.alibaba.fastjson2.annotation.JSONField;
import com.alibaba.fastjson2.annotation.JSONType;
import com.alibaba.qwen.code.cli.protocol.message.MessageBase;
import com.alibaba.qwen.code.cli.protocol.message.assistant.event.StreamEvent;

/**
 * Represents a partial assistant message during streaming.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeKey = "type", typeName = "stream_event")
public class SDKPartialAssistantMessage extends MessageBase {
    /**
     * The UUID of the message.
     */
    private String uuid;

    /**
     * The session ID.
     */
    @JSONField(name = "session_id")
    private String sessionId;
    /**
     * The stream event.
     */
    private StreamEvent event;

    /**
     * The parent tool use ID.
     */
    @JSONField(name = "parent_tool_use_id")
    private String parentToolUseId;

    /**
     * Creates a new SDKPartialAssistantMessage instance and sets the type to "stream_event".
     */
    public SDKPartialAssistantMessage() {
        super();
        this.type = "stream_event";
    }

    /**
     * Gets the UUID of the message.
     *
     * @return The UUID of the message
     */
    public String getUuid() {
        return uuid;
    }

    /**
     * Sets the UUID of the message.
     *
     * @param uuid The UUID of the message
     */
    public void setUuid(String uuid) {
        this.uuid = uuid;
    }

    /**
     * Gets the session ID.
     *
     * @return The session ID
     */
    public String getSessionId() {
        return sessionId;
    }

    /**
     * Sets the session ID.
     *
     * @param sessionId The session ID
     */
    public void setSessionId(String sessionId) {
        this.sessionId = sessionId;
    }

    /**
     * Gets the stream event.
     *
     * @return The stream event
     */
    public StreamEvent getEvent() {
        return event;
    }

    /**
     * Sets the stream event.
     *
     * @param event The stream event
     */
    public void setEvent(StreamEvent event) {
        this.event = event;
    }

    /**
     * Gets the parent tool use ID.
     *
     * @return The parent tool use ID
     */
    public String getParentToolUseId() {
        return parentToolUseId;
    }

    /**
     * Sets the parent tool use ID.
     *
     * @param parentToolUseId The parent tool use ID
     */
    public void setParentToolUseId(String parentToolUseId) {
        this.parentToolUseId = parentToolUseId;
    }
}
