package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.api.TerminalTicketController;
import com.alibaba.qwen.code.managedagent.api.TerminalTicketStore;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import jakarta.websocket.server.ServerContainer;
import org.junit.jupiter.api.Test;
import org.springframework.core.env.MapPropertySource;
import org.springframework.mock.web.MockServletContext;
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext;

import java.time.Clock;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * The terminal endpoint must actually boot when the Runtime Broker is
 * enabled. The ticket store is a singleton shared by the ticket controller
 * (which mints) and the handshake interceptor (which consumes); a config that
 * injects its own @Bean product through its constructor forms a creation cycle
 * and fails the whole context at startup.
 */
class TerminalWebSocketConfigTest {
    private static AnnotationConfigWebApplicationContext terminalContext(
            Class<?>... extra) {
        AnnotationConfigWebApplicationContext ctx =
                new AnnotationConfigWebApplicationContext();
        // ServletServerContainerFactoryBean reads the container the servlet
        // initializer would have published; a bare MockServletContext has none.
        MockServletContext servletContext = new MockServletContext();
        servletContext.setAttribute("jakarta.websocket.server.ServerContainer",
                mock(ServerContainer.class));
        ctx.setServletContext(servletContext);
        ctx.getEnvironment().getPropertySources().addFirst(new MapPropertySource(
                "terminal-test",
                Map.of("qwen.managed-agent.runtime-broker.enabled", "true")));
        // Manual singletons: a Mockito mock of a class with @Autowired methods
        // must not go through bean creation, or Spring re-injects those methods.
        ctx.addBeanFactoryPostProcessor(factory -> {
            factory.registerSingleton("runtimeBrokerService",
                    mock(RuntimeBrokerService.class));
            factory.registerSingleton("managedAgentService",
                    mock(ManagedAgentService.class));
            factory.registerSingleton("managedAgentSettings",
                    mock(ManagedAgentSettings.class));
            factory.registerSingleton("managedAgentClock", Clock.systemUTC());
        });
        Class<?>[] configs = new Class<?>[extra.length + 1];
        configs[0] = TerminalWebSocketConfig.class;
        System.arraycopy(extra, 0, configs, 1, extra.length);
        ctx.register(configs);
        return ctx;
    }

    @Test
    void contextLoadsWithoutACreationCycle() {
        try (AnnotationConfigWebApplicationContext ctx = terminalContext()) {
            ctx.refresh();
            assertThat(ctx.getBean(TerminalTicketStore.class)).isNotNull();
        }
    }

    @Test
    void onlyOneTicketStoreSingletonExists() {
        try (AnnotationConfigWebApplicationContext ctx =
                terminalContext(TerminalTicketController.class)) {
            ctx.refresh();
            // The controller mints and the interceptor consumes; both must
            // resolve the very same store, or every upgrade is refused.
            assertThat(ctx.getBeansOfType(TerminalTicketStore.class)).hasSize(1);
            assertThat(ctx.getBean(TerminalTicketController.class)).isNotNull();
        }
    }
}
