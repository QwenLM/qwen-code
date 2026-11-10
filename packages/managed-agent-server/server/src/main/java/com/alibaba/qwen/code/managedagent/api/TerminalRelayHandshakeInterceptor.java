package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceTerminalRelayService;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Authenticates and admits a Managed Web Terminal handshake. The servlet
 * filter chain has already established the tenant actor principal; this
 * interceptor re-checks the tenant header against it, then runs the terminal
 * admission (OPERATOR, Shell profile, opt-ins, terminal-capable READY
 * binding). A refusal answers the typed error and rejects the upgrade; the
 * relay never opens on an ambiguous state.
 */
public final class TerminalRelayHandshakeInterceptor implements HandshakeInterceptor {
    public static final String BINDING_ATTRIBUTE =
            TerminalRelayHandshakeInterceptor.class.getName() + ".binding";
    public static final String SESSION_ATTRIBUTE =
            TerminalRelayHandshakeInterceptor.class.getName() + ".sessionId";
    public static final String TERMINAL_ATTRIBUTE =
            TerminalRelayHandshakeInterceptor.class.getName() + ".terminalId";
    private static final Pattern SESSION_PATH = Pattern.compile(
            "^/api/agent/web-shell/v1/sessions/([^/]+)/terminal$");
    private static final int MAX_TERMINAL_ID_LENGTH = 256;

    private final WorkspaceTerminalRelayService relay;

    public TerminalRelayHandshakeInterceptor(WorkspaceTerminalRelayService relay) {
        this.relay = relay;
    }

    @Override
    public boolean beforeHandshake(ServerHttpRequest request,
            ServerHttpResponse response, WebSocketHandler wsHandler,
            Map<String, Object> attributes) {
        if (!(request instanceof ServletServerHttpRequest servletRequest)) {
            response.setStatusCode(HttpStatus.BAD_REQUEST);
            return false;
        }
        HttpServletRequest http = servletRequest.getServletRequest();
        String path = http.getRequestURI();
        String context = http.getContextPath();
        if (context != null && !context.isEmpty() && path.startsWith(context)) {
            path = path.substring(context.length());
        }
        Matcher matcher = SESSION_PATH.matcher(path);
        if (!matcher.matches()) {
            response.setStatusCode(HttpStatus.NOT_FOUND);
            return false;
        }
        String sessionId = matcher.group(1);
        String terminalId = http.getParameter("terminalId");
        if (terminalId == null || terminalId.isEmpty()
                || terminalId.length() > MAX_TERMINAL_ID_LENGTH) {
            response.setStatusCode(HttpStatus.BAD_REQUEST);
            return false;
        }
        String tenantId = http.getHeader(TenantContextFilter.HEADER);
        String actorId = null;
        if (http.getUserPrincipal() instanceof AuthenticatedTenantActor actor) {
            if (tenantId == null || !tenantId.equals(actor.tenantId())) {
                response.setStatusCode(HttpStatus.FORBIDDEN);
                return false;
            }
            actorId = actor.actorId();
        }
        if (tenantId == null) {
            response.setStatusCode(HttpStatus.BAD_REQUEST);
            return false;
        }
        try {
            RuntimeBindingRecord binding = relay.admit(tenantId, actorId, sessionId);
            attributes.put(BINDING_ATTRIBUTE, binding);
            attributes.put(SESSION_ATTRIBUTE, sessionId);
            attributes.put(TERMINAL_ATTRIBUTE, terminalId);
            return true;
        } catch (ManagedAgentException refusal) {
            response.setStatusCode(HttpStatus.valueOf(refusal.getStatus()));
            return false;
        }
    }

    @Override
    public void afterHandshake(ServerHttpRequest request,
            ServerHttpResponse response, WebSocketHandler wsHandler,
            Exception exception) {
        // Nothing to clean up: the relay owns the worker connection lifecycle.
    }
}
