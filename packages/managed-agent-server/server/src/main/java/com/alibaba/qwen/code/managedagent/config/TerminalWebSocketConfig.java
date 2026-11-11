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
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

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
    private final Clock clock;

    public TerminalWebSocketConfig(RuntimeBrokerService broker,
            @Qualifier("managedAgentClock") Clock clock) {
        this.broker = broker;
        this.clock = clock;
    }

    @Bean
    public TerminalTicketStore terminalTicketStore() {
        return new TerminalTicketStore(clock);
    }

    @Bean
    public WorkspaceTerminalRelayService workspaceTerminalRelayService(
            ManagedAgentService sessions, RuntimeBrokerService broker,
            ManagedAgentSettings settings) {
        return new WorkspaceTerminalRelayService(sessions, broker, settings);
    }

    /**
     * The browser leg must accept a whole paste as one message. Tomcat's
     * default 8 KiB buffer would close a larger frame with 1009 before the
     * relay ever sees it. Raise the container ceiling to the relay's own
     * pending-byte bound (8 MiB); a larger buffer would only move the
     * rejection into the relay's send() accounting.
     */
    @Bean
    public ServletServerContainerFactoryBean terminalWebSocketContainer() {
        ServletServerContainerFactoryBean container =
                new ServletServerContainerFactoryBean();
        int maxMessageBytes = 8 * 1024 * 1024;
        container.setMaxBinaryMessageBufferSize(maxMessageBytes);
        container.setMaxTextMessageBufferSize(maxMessageBytes);
        return container;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        // The intercepted @Bean call returns the singleton the ticket
        // controller also injects; mint and consume must share one store.
        registry.addHandler(new TerminalRelayHandler(broker),
                        "/api/agent/web-shell/v1/sessions/*/terminal")
                .addInterceptors(
                        new TerminalRelayHandshakeInterceptor(terminalTicketStore()));
    }
}
