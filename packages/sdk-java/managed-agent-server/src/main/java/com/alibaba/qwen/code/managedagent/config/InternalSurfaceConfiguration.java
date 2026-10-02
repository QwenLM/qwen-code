package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.apache.catalina.connector.Connector;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Binds the internal surface (/internal/**) to its own connector when
 * qwen.managed-agent.internal-server.port is set, and keeps each route on
 * its own listener: internal paths answer 404 on the public connector and
 * everything else answers 404 on the internal one.
 */
@Configuration
public class InternalSurfaceConfiguration
        implements WebServerFactoryCustomizer<TomcatServletWebServerFactory> {
    private static final Logger LOG = LoggerFactory.getLogger(
            InternalSurfaceConfiguration.class);
    private final ManagedAgentProperties properties;

    public InternalSurfaceConfiguration(ManagedAgentProperties properties) {
        this.properties = properties;
    }

    @Override
    public void customize(TomcatServletWebServerFactory factory) {
        int port = properties.getInternalServer().getPort();
        if (port <= 0) {
            return;
        }
        if (factory.getSsl() != null && factory.getSsl().isEnabled()) {
            // Additional connectors do not inherit server.ssl; say so
            // instead of serving plaintext beside a TLS public listener.
            LOG.warn("The internal listener on port {} serves plaintext;"
                    + " server.ssl applies to the public connector only.",
                    port);
        }
        Connector connector = new Connector(
                TomcatServletWebServerFactory.DEFAULT_PROTOCOL);
        connector.setPort(port);
        String address = properties.getInternalServer().getAddress();
        try {
            if (!connector.setProperty("address", java.net.InetAddress
                    .getByName(address).getHostAddress())) {
                throw new IllegalStateException(
                        "qwen.managed-agent.internal-server.address was"
                                + " rejected by the connector: " + address);
            }
        } catch (java.net.UnknownHostException error) {
            throw new IllegalStateException(
                    "qwen.managed-agent.internal-server.address is invalid: "
                            + address, error);
        }
        factory.addAdditionalTomcatConnectors(connector);
    }

    @Component
    public static class RoutingFilter extends OncePerRequestFilter
            implements Ordered {
        private final int internalPort;

        public RoutingFilter(ManagedAgentProperties properties) {
            this.internalPort = properties.getInternalServer().getPort();
        }

        @Override
        public int getOrder() {
            return Ordered.HIGHEST_PRECEDENCE;
        }

        @Override
        protected boolean shouldNotFilter(HttpServletRequest request) {
            return internalPort <= 0;
        }

        @Override
        protected void doFilterInternal(HttpServletRequest request,
                HttpServletResponse response, FilterChain chain)
                throws ServletException, IOException {
            boolean internal = request.getLocalPort() == internalPort;
            if (internal != request.getRequestURI().startsWith("/internal/")) {
                response.setStatus(HttpServletResponse.SC_NOT_FOUND);
                response.setContentType(MediaType.APPLICATION_JSON_VALUE);
                new ObjectMapper().writeValue(response.getOutputStream(),
                        ApiExceptionHandler.envelope(request, "not_found",
                                "The requested endpoint does not exist on this listener."));
                return;
            }
            chain.doFilter(request, response);
        }
    }
}
