package com.alibaba.qwen.code.managedagent.api;

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
 * Consumes the short-lived ticket a browser offers on the terminal WebSocket
 * upgrade. Browsers cannot set the deployment's authentication headers on a
 * WebSocket, so the full terminal admission runs on the authenticated
 * ticket endpoint and is carried here by a single-use ticket offered as the
 * bearer subprotocol. The upgrade only consumes the ticket and re-checks that
 * it names this URL's Session and terminal; it never re-reads a principal.
 */
public final class TerminalRelayHandshakeInterceptor implements HandshakeInterceptor {
    public static final String BINDING_ATTRIBUTE =
            TerminalRelayHandshakeInterceptor.class.getName() + ".binding";
    public static final String SESSION_ATTRIBUTE =
            TerminalRelayHandshakeInterceptor.class.getName() + ".sessionId";
    public static final String TERMINAL_ATTRIBUTE =
            TerminalRelayHandshakeInterceptor.class.getName() + ".terminalId";
    /** Keep in sync with the Web Shell's bearer subprotocol prefix. */
    public static final String BEARER_SUBPROTOCOL_PREFIX = "qwen-bearer.";
    private static final Pattern SESSION_PATH = Pattern.compile(
            "^/api/agent/web-shell/v1/sessions/([^/]+)/terminal$");
    private static final Pattern PATH_SAFE = Pattern.compile("[A-Za-z0-9._-]{1,256}");

    private final TerminalTicketStore tickets;

    public TerminalRelayHandshakeInterceptor(TerminalTicketStore tickets) {
        this.tickets = tickets;
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
        if (terminalId == null || !PATH_SAFE.matcher(terminalId).matches()
                || !PATH_SAFE.matcher(sessionId).matches()) {
            response.setStatusCode(HttpStatus.BAD_REQUEST);
            return false;
        }
        TerminalTicketStore.Admission admission = tickets.consume(bearerTicket(http));
        if (admission == null
                || !admission.sessionId().equals(sessionId)
                || !admission.terminalId().equals(terminalId)) {
            response.setStatusCode(HttpStatus.UNAUTHORIZED);
            return false;
        }
        attributes.put(BINDING_ATTRIBUTE, admission.binding());
        attributes.put(SESSION_ATTRIBUTE, sessionId);
        attributes.put(TERMINAL_ATTRIBUTE, terminalId);
        return true;
    }

    /** The ticket rides the bearer subprotocol; never a URL parameter. */
    private static String bearerTicket(HttpServletRequest http) {
        String protocols = http.getHeader("Sec-WebSocket-Protocol");
        if (protocols == null) {
            return null;
        }
        for (String offered : protocols.split(",")) {
            String trimmed = offered.trim();
            if (trimmed.startsWith(BEARER_SUBPROTOCOL_PREFIX)) {
                return trimmed.substring(BEARER_SUBPROTOCOL_PREFIX.length());
            }
        }
        return null;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request,
            ServerHttpResponse response, WebSocketHandler wsHandler,
            Exception exception) {
        // Nothing to clean up: the relay owns the worker connection lifecycle.
    }
}
