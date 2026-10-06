package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.api.ApiExceptionHandler;
import com.alibaba.qwen.code.managedagent.api.PublicSurface;
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
        // Additional connectors never inherit server.ssl.
        boolean tls = factory.getSsl() != null && factory.getSsl().isEnabled();
        boolean loopback = BrokerSecurity.isLoopback(
                properties.getInternalServer().getAddress());
        if (tls) {
            LOG.warn("The internal listener on port {} serves plaintext;"
                    + " server.ssl applies to the public connector only.",
                    port);
        }
        if (!loopback) {
            LOG.warn("The internal listener on port {} binds a non-loopback"
                    + " address and never inherits TLS; the writer credential"
                    + " crosses in cleartext.", port);
        }
        Connector connector = new Connector(
                TomcatServletWebServerFactory.DEFAULT_PROTOCOL);
        connector.setPort(port);
        String address = properties.getInternalServer().getAddress();
        String hostAddress;
        try {
            hostAddress = java.net.InetAddress.getByName(address)
                    .getHostAddress();
            if (!connector.setProperty("address", hostAddress)) {
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
        LOG.info("The internal listener binds {}:{}", hostAddress, port);
    }

    @Component
    public static class RoutingFilter extends OncePerRequestFilter
            implements Ordered {
        private final int internalPort;
        private final ObjectMapper objectMapper;

        public RoutingFilter(ManagedAgentProperties properties,
                ObjectMapper objectMapper) {
            this.internalPort = properties.getInternalServer().getPort();
            this.objectMapper = objectMapper;
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
            // Classify on the routed path: raw-URI spellings such as
            // /%69nternal/... or /internal;/... map to internal handlers.
            if (internal != PublicSurface.pathWithinApplication(request)
                    .startsWith("/internal/")) {
                response.setStatus(HttpServletResponse.SC_NOT_FOUND);
                response.setContentType(MediaType.APPLICATION_JSON_VALUE);
                objectMapper.writeValue(response.getOutputStream(),
                        ApiExceptionHandler.envelope(request, "not_found",
                                "The requested endpoint does not exist on this listener."));
                return;
            }
            chain.doFilter(request, response);
        }
    }
}
