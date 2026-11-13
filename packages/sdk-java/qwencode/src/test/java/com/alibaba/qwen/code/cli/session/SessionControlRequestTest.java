package com.alibaba.qwen.code.cli.session;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.alibaba.qwen.code.cli.protocol.message.control.CLIControlRequest;
import com.alibaba.qwen.code.cli.protocol.message.control.CLIControlResponse;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.ControlResponsePayload;
import com.alibaba.qwen.code.cli.session.event.consumers.SessionEventSimpleConsumers;
import com.alibaba.qwen.code.cli.session.exception.SessionSendPromptException;
import com.alibaba.qwen.code.cli.transport.Transport;
import com.alibaba.qwen.code.cli.transport.TransportOptions;
import com.alibaba.qwen.code.cli.utils.Timeout;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SessionControlRequestTest {
    private static final String REQUEST_ID = "permission-request-1";

    @Test
    void sendsCorrelatedErrorWhenControlHandlerThrows() throws Exception {
        FixtureTransport transport = new FixtureTransport();
        Session session = new Session(transport);

        session.sendPrompt("test", consumers(request -> {
            throw new IllegalStateException("Permission callback failed");
        }));

        JSONObject response = assertErrorResponse(transport);
        assertTrue(response.getString("error").contains("Permission callback failed"));
        assertTrue(transport.resultConsumed);
    }

    @Test
    void sendsCorrelatedErrorWhenControlHandlerReturnsNull() throws Exception {
        FixtureTransport transport = new FixtureTransport();
        new Session(transport).sendPrompt("test", consumers(request -> null));

        assertErrorResponse(transport);
        assertTrue(transport.resultConsumed);
    }

    @Test
    void sendsCorrelatedErrorWhenControlHandlerReturnsAnEmptyEnvelope() throws Exception {
        FixtureTransport transport = new FixtureTransport();
        new Session(transport).sendPrompt("test", consumers(request -> new CLIControlResponse<>()));

        assertErrorResponse(transport);
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {"", "another-request"})
    void sendsCorrelatedErrorWhenControlHandlerReturnsAnUnrelatedRequestId(String requestId) throws Exception {
        FixtureTransport transport = new FixtureTransport();
        new Session(transport).sendPrompt("test", consumers(request -> success(requestId)));

        assertErrorResponse(transport);
        assertTrue(transport.resultConsumed);
    }

    @Test
    void sendsCorrelatedErrorWhenControlHandlerReturnsSuccessWithoutAPayload() throws Exception {
        FixtureTransport transport = new FixtureTransport();
        CLIControlResponse<ControlResponsePayload> response = new CLIControlResponse<>();
        response.createResponse().setRequestId(REQUEST_ID);
        new Session(transport).sendPrompt("test", consumers(request -> response));

        assertErrorResponse(transport);
        assertTrue(transport.resultConsumed);
    }

    @Test
    void preservesAValidErrorResponseWithoutASuccessPayload() throws Exception {
        FixtureTransport transport = new FixtureTransport();
        CLIControlResponse<ControlResponsePayload> response = new CLIControlResponse<>();
        response.createResponse().setRequestId(REQUEST_ID).setSubtype("error").setError("Callback denied the request");
        String expectedJson = response.toString();
        new Session(transport).sendPrompt("test", consumers(request -> response));

        assertEquals(expectedJson, transport.written.get(0));
        assertEquals("Callback denied the request", assertErrorResponse(transport).getString("error"));
        assertTrue(transport.resultConsumed);
    }

    @Test
    @org.junit.jupiter.api.Timeout(value = 2, unit = TimeUnit.SECONDS)
    void sendsCorrelatedErrorWhenControlHandlerTimesOut() throws Exception {
        FixtureTransport transport = new FixtureTransport();
        CountDownLatch release = new CountDownLatch(1);
        try {
            new Session(transport).sendPrompt("test", new SessionEventSimpleConsumers() {
                @Override
                public CLIControlResponse<? extends ControlResponsePayload> onControlRequest(
                        Session session, CLIControlRequest<?> request) {
                    try {
                        release.await();
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    return success(request.getRequestId());
                }

                @Override
                public Timeout onControlRequestTimeout(Session session, CLIControlRequest<?> request) {
                    return new Timeout(20L, TimeUnit.MILLISECONDS);
                }
            });

            assertErrorResponse(transport);
            assertTrue(transport.resultConsumed);
        } finally {
            release.countDown();
        }
    }

    @Test
    void preservesAValidControlResponseAndContinuesTheTurn() throws Exception {
        FixtureTransport transport = new FixtureTransport();
        CLIControlResponse<ControlResponsePayload> expected = success(REQUEST_ID);
        String expectedJson = expected.toString();
        new Session(transport).sendPrompt("test", consumers(request -> expected));

        assertEquals(1, transport.written.size());
        assertEquals(expectedJson, transport.written.get(0));
        assertEquals("success", JSON.parseObject(transport.written.get(0)).getJSONObject("response").getString("subtype"));
        assertFalse(JSON.parseObject(transport.written.get(0)).getJSONObject("response").containsKey("error"));
        assertTrue(transport.resultConsumed);
    }

    @Test
    void propagatesFallbackWriteFailureFromASynchronousTransport() throws Exception {
        FixtureTransport transport = new FixtureTransport();
        transport.writeFailure = new IOException("Pipe closed");
        Session session = new Session(transport);

        SessionSendPromptException failure = assertThrows(SessionSendPromptException.class,
                () -> session.sendPrompt("test", consumers(request -> null)));

        assertEquals("Failed to send control response", failure.getCause().getMessage());
        assertEquals("Pipe closed", failure.getCause().getCause().getMessage());
        assertFalse(transport.resultConsumed);
    }

    private static SessionEventSimpleConsumers consumers(
            Function<CLIControlRequest<?>, CLIControlResponse<? extends ControlResponsePayload>> handler) {
        return new SessionEventSimpleConsumers() {
            @Override
            public CLIControlResponse<? extends ControlResponsePayload> onControlRequest(
                    Session session, CLIControlRequest<?> request) {
                return handler.apply(request);
            }
        };
    }

    private static CLIControlResponse<ControlResponsePayload> success(String requestId) {
        CLIControlResponse<ControlResponsePayload> response = new CLIControlResponse<>();
        response.createResponse().setRequestId(requestId).setResponse(new ControlResponsePayload());
        return response;
    }

    private static JSONObject assertErrorResponse(FixtureTransport transport) {
        assertEquals(1, transport.written.size());
        JSONObject envelope = JSON.parseObject(transport.written.get(0));
        assertEquals("control_response", envelope.getString("type"));
        JSONObject response = envelope.getJSONObject("response");
        assertNotNull(response, "The CLI must be able to recognize a control response");
        assertEquals(REQUEST_ID, response.getString("request_id"));
        assertEquals("error", response.getString("subtype"));
        assertNotNull(response.getString("error"));
        assertFalse(response.getString("error").isBlank());
        return response;
    }

    private static class FixtureTransport implements Transport {
        private final List<String> written = new ArrayList<>();
        private boolean resultConsumed;
        private IOException writeFailure;

        @Override
        public TransportOptions getTransportOptions() {
            return new TransportOptions();
        }

        @Override
        public boolean isReading() {
            return false;
        }

        @Override
        public void start() {}

        @Override
        public void close() {}

        @Override
        public boolean isAvailable() {
            return true;
        }

        @Override
        public String inputWaitForOneLine(String message) {
            return "{\"type\":\"control_response\",\"response\":{\"request_id\":\"init\",\"subtype\":\"success\","
                    + "\"response\":{\"subtype\":\"initialize\",\"capabilities\":{}}}}";
        }

        @Override
        public void inputWaitForMultiLine(String message, Function<String, Boolean> consumer) {
            consumer.apply("{\"type\":\"control_request\",\"request_id\":\"" + REQUEST_ID
                    + "\",\"request\":{\"subtype\":\"can_use_tool\",\"tool_name\":\"run_shell_command\",\"input\":{}}}");
            resultConsumed = consumer.apply("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false}");
        }

        @Override
        public void inputNoWaitResponse(String message) throws IOException {
            if (writeFailure != null) {
                throw writeFailure;
            }
            written.add(message);
        }
    }
}
