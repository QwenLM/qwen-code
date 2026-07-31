package com.alibaba.qwen.code.cli.protocol.message.assistant.event;

import com.alibaba.fastjson2.annotation.JSONType;

/**
 * Represents a message stop event during message streaming.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
@JSONType(typeName = "message_stop")
public class MessageStopStreamEvent extends StreamEvent{
}
