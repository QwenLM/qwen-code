package com.alibaba.qwen.code.managedagent.api;

import org.junit.jupiter.api.Test;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.http.server.ServletServerHttpResponse;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.time.Clock;
import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The upgrade's only authentication is the single-use ticket: the interceptor
 * must consume it once and re-check that it names this URL's Session and
 * terminal, refusing every other shape.
 */
class TerminalRelayHandshakeInterceptorTest {
    private final TerminalTicketStore tickets =
            new TerminalTicketStore(Clock.systemUTC());
    private final TerminalRelayHandshakeInterceptor interceptor =
            new TerminalRelayHandshakeInterceptor(tickets);

    private String mint(String sessionId, String terminalId) {
        return tickets.issue(new TerminalTicketStore.Admission(
                "tenant", "actor", sessionId, terminalId, null));
    }

    private boolean handshake(String path, String terminalId, String ticket,
            Map<String, Object> attributes, MockHttpServletResponse response) {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", path);
        if (terminalId != null) {
            request.setParameter("terminalId", terminalId);
        }
        if (ticket != null) {
            request.addHeader("Sec-WebSocket-Protocol",
                    "qwen-ws, " + TerminalRelayHandshakeInterceptor.BEARER_SUBPROTOCOL_PREFIX + ticket);
        }
        return interceptor.beforeHandshake(
                new ServletServerHttpRequest(request),
                new ServletServerHttpResponse(response), null, attributes);
    }

    @Test
    void admitsAValidTicketAndCarriesTheAdmission() {
        String ticket = mint("session-a", "term-1");
        Map<String, Object> attributes = new HashMap<>();
        MockHttpServletResponse response = new MockHttpServletResponse();
        assertThat(handshake("/api/agent/web-shell/v1/sessions/session-a/terminal",
                "term-1", ticket, attributes, response)).isTrue();
        assertThat(attributes.get(TerminalRelayHandshakeInterceptor.SESSION_ATTRIBUTE))
                .isEqualTo("session-a");
        assertThat(attributes.get(TerminalRelayHandshakeInterceptor.TERMINAL_ATTRIBUTE))
                .isEqualTo("term-1");
        assertThat(attributes).containsKey(TerminalRelayHandshakeInterceptor.BINDING_ATTRIBUTE);
    }

    @Test
    void refusesAnUnknownOrReplayedTicket() {
        Map<String, Object> attributes = new HashMap<>();
        MockHttpServletResponse response = new MockHttpServletResponse();
        assertThat(handshake("/api/agent/web-shell/v1/sessions/session-a/terminal",
                "term-1", "not-a-ticket", attributes, response)).isFalse();
        assertThat(response.getStatus()).isEqualTo(401);

        String ticket = mint("session-a", "term-1");
        assertThat(handshake("/api/agent/web-shell/v1/sessions/session-a/terminal",
                "term-1", ticket, new HashMap<>(), new MockHttpServletResponse())).isTrue();
        MockHttpServletResponse replay = new MockHttpServletResponse();
        assertThat(handshake("/api/agent/web-shell/v1/sessions/session-a/terminal",
                "term-1", ticket, new HashMap<>(), replay)).isFalse();
        assertThat(replay.getStatus()).isEqualTo(401);
    }

    @Test
    void refusesATicketNamingAnotherSessionOrTerminal() {
        String ticket = mint("session-a", "term-1");
        MockHttpServletResponse otherSession = new MockHttpServletResponse();
        assertThat(handshake("/api/agent/web-shell/v1/sessions/session-b/terminal",
                "term-1", ticket, new HashMap<>(), otherSession)).isFalse();
        assertThat(otherSession.getStatus()).isEqualTo(401);

        String ticket2 = mint("session-a", "term-1");
        MockHttpServletResponse otherTerminal = new MockHttpServletResponse();
        assertThat(handshake("/api/agent/web-shell/v1/sessions/session-a/terminal",
                "term-2", ticket2, new HashMap<>(), otherTerminal)).isFalse();
        assertThat(otherTerminal.getStatus()).isEqualTo(401);
    }

    @Test
    void refusesAMissingOrUnsafeTerminalId() {
        String ticket = mint("session-a", "term-1");
        MockHttpServletResponse missing = new MockHttpServletResponse();
        assertThat(handshake("/api/agent/web-shell/v1/sessions/session-a/terminal",
                null, ticket, new HashMap<>(), missing)).isFalse();
        assertThat(missing.getStatus()).isEqualTo(400);

        String ticket2 = mint("session-a", "term-1");
        MockHttpServletResponse unsafe = new MockHttpServletResponse();
        assertThat(handshake("/api/agent/web-shell/v1/sessions/session-a/terminal",
                "../escape", ticket2, new HashMap<>(), unsafe)).isFalse();
        assertThat(unsafe.getStatus()).isEqualTo(400);
    }

    @Test
    void refusesANonTerminalPath() {
        String ticket = mint("session-a", "term-1");
        MockHttpServletResponse response = new MockHttpServletResponse();
        assertThat(handshake("/api/agent/web-shell/v1/sessions/session-a/other",
                "term-1", ticket, new HashMap<>(), response)).isFalse();
        assertThat(response.getStatus()).isEqualTo(404);
    }

    @Test
    void refusesAnUpgradeWithoutABearerTicket() {
        MockHttpServletResponse response = new MockHttpServletResponse();
        assertThat(handshake("/api/agent/web-shell/v1/sessions/session-a/terminal",
                "term-1", null, new HashMap<>(), response)).isFalse();
        assertThat(response.getStatus()).isEqualTo(401);
    }
}