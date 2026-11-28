package com.alibaba.qwen.code.runtimebroker.http;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.security.PublicSurface;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.Ordered;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;

@ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker", name = "enabled", havingValue = "true")
public final class RuntimeBrokerAuthenticationFilter extends OncePerRequestFilter
        implements Ordered {
    private final byte[] authorization;

    public RuntimeBrokerAuthenticationFilter(ManagedAgentProperties properties) {
        this.authorization = ("Bearer "
                + BrokerValues.requireId(properties.getRuntimeBroker().getToken(), "token"))
                .getBytes(StandardCharsets.UTF_8);
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE + 1;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = PublicSurface.pathWithinApplication(request);
        return !path.equals(RuntimeBrokerHttpProtocol.ROUTE_PREFIX)
                && !path.startsWith(RuntimeBrokerHttpProtocol.ROUTE_PREFIX + "/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
            HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (authorized(authorization, request.getHeader("Authorization"))) {
            // Broker consumes raw JSON in its bounded executor. Suppress the
            // servlet multipart resolver, which would otherwise read the body
            // eagerly on the shared connector thread.
            chain.doFilter(new HttpServletRequestWrapper(request) {
                @Override
                public String getContentType() {
                    return "application/octet-stream";
                }
            }, response);
            return;
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "Runtime Broker authentication failed.");
        body.put("code", "runtime_broker_unauthorized");
        body.put("retryable", false);
        byte[] bytes = JsonCodec.encode(body);
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType("application/json; charset=utf-8");
        response.setContentLengthLong(bytes.length);
        response.getOutputStream().write(bytes);
    }

    static boolean authorized(byte[] authorization, String provided) {
        return provided != null && MessageDigest.isEqual(authorization,
                provided.getBytes(StandardCharsets.UTF_8));
    }
}
