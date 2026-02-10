package com.alibaba.qwen.code.cli.protocol.message;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.annotation.JSONField;
import com.alibaba.fastjson2.annotation.JSONType;

/**
 * Base class for messages in the Qwen Code protocol.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(alphabetic = false, typeKey = "type", typeName = "MessageBase")
public class MessageBase implements Message{
    /**
     * The type of the message.
     */
    protected String type;

    /**
     * The ID of the message.
     */
    @JSONField(name = "message_id")
    protected String messageId;

    /**
     * <p>toString.</p>
     *
     * @return a {@link java.lang.String} object.
     */
    public String toString() {
        return JSON.toJSONString(this);
    }

    /** {@inheritDoc} */
    @Override
    public String getType() {
        return type;
    }

    /**
     * Sets the type of the message.
     *
     * @param type The type of the message
     */
    public void setType(String type) {
        this.type = type;
    }

    /** {@inheritDoc} */
    @Override
    public String getMessageId() {
        return messageId;
    }

    /**
     * Sets the ID of the message.
     *
     * @param messageId The ID of the message
     */
    public void setMessageId(String messageId) {
        this.messageId = messageId;
    }
}
