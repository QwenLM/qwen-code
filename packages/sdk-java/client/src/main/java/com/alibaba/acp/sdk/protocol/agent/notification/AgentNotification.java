package com.alibaba.acp.sdk.protocol.agent.notification;

import com.alibaba.acp.sdk.protocol.jsonrpc.MethodMessage;

public class AgentNotification<P> extends MethodMessage<P> {
    public AgentNotification() {
    }

    public AgentNotification(String method, P params) {
        super(method, params);
    }
}
