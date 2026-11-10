package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.api.TerminalRelayHandler;
import com.alibaba.qwen.code.managedagent.api.TerminalRelayHandshakeInterceptor;
import com.alibaba.qwen.code.managedagent.api.TerminalTicketStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceTerminalRelayService;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

import java.time.Clock;

/**
 * The Managed Web Terminal endpoint. Registered only when the Runtime Broker
 * is enabled, because a terminal-capable binding only exists there. The full
 * terminal admission runs on the authenticated ticket endpoint; the upgrade
 * consumes the short-lived ticket, so the endpoint answers a typed refusal
 * until the opt-in is turned on and a valid ticket is offered.
 */
@Configuration
@EnableWebSocket
@ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
        name = "enabled", havingValue = "true")
public class TerminalWebSocketConfig implements WebSocketConfigurer {
    private final RuntimeBrokerService broker;
    private final TerminalTicketStore tickets;

    public TerminalWebSocketConfig(RuntimeBrokerService broker,
            TerminalTicketStore tickets) {
        this.broker = broker;
        this.tickets = tickets;
    }

    @Bean
    public TerminalTicketStore terminalTicketStore(
            @Qualifier("managedAgentClock") Clock clock) {
        return new TerminalTicketStore(clock);
    }

    @Bean
    public WorkspaceTerminalRelayService workspaceTerminalRelayService(
            ManagedAgentService sessions, RuntimeBrokerService broker,
            ManagedAgentSettings settings) {
        return new WorkspaceTerminalRelayService(sessions, broker, settings);
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(new TerminalRelayHandler(broker),
                        "/api/agent/web-shell/v1/sessions/*/terminal")
                .addInterceptors(new TerminalRelayHandshakeInterceptor(tickets));
    }
}
