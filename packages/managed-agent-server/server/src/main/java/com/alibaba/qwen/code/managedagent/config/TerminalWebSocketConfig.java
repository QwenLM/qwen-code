package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.api.TerminalRelayHandler;
import com.alibaba.qwen.code.managedagent.api.TerminalRelayHandshakeInterceptor;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceTerminalRelayService;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * The Managed Web Terminal endpoint. Registered only when the Runtime Broker
 * is enabled, because a terminal-capable binding only exists there; the
 * terminal deployment opt-in is enforced per handshake by the relay, so the
 * endpoint answers a typed refusal until the opt-in is turned on.
 */
@Configuration
@EnableWebSocket
@ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
        name = "enabled", havingValue = "true")
public class TerminalWebSocketConfig implements WebSocketConfigurer {
    private final WorkspaceTerminalRelayService relay;

    public TerminalWebSocketConfig(ManagedAgentService sessions,
            RuntimeBrokerService broker, ManagedAgentSettings settings) {
        this.relay = new WorkspaceTerminalRelayService(sessions, broker, settings);
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(new TerminalRelayHandler(),
                        "/api/agent/web-shell/v1/sessions/*/terminal")
                .addInterceptors(new TerminalRelayHandshakeInterceptor(relay));
    }
}
