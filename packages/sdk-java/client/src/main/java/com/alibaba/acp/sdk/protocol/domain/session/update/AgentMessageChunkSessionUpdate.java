package com.alibaba.acp.sdk.protocol.domain.session.update;

import com.alibaba.acp.sdk.protocol.domain.content.block.ContentBlock;
import com.alibaba.fastjson2.annotation.JSONType;

@JSONType(typeName = "agent_message_chunk")
public class AgentMessageChunkSessionUpdate extends SessionUpdate {
    private ContentBlock content;

    public AgentMessageChunkSessionUpdate() {
        this.setSessionUpdate("agent_message_chunk");
    }

    public ContentBlock getContent() {
        return content;
    }

    public void setContent(ContentBlock content) {
        this.content = content;
    }
}
