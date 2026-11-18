package com.alibaba.qwen.code.cli.session;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.alibaba.qwen.code.cli.protocol.data.behavior.Behavior;
import com.alibaba.qwen.code.cli.protocol.data.behavior.Behavior.Operation;
import com.alibaba.qwen.code.cli.protocol.message.control.CLIControlRequest;
import com.alibaba.qwen.code.cli.protocol.message.control.CLIControlResponse;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.CLIControlPermissionRequest;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.ControlRequestPayload;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.ControlResponsePayload;
import com.alibaba.qwen.code.cli.session.event.consumers.AssistantContentSimpleConsumers;
import com.alibaba.qwen.code.cli.session.event.consumers.SessionEventSimpleConsumers;
import com.alibaba.qwen.code.cli.transport.Transport;
import com.alibaba.qwen.code.cli.transport.TransportOptions;
import com.alibaba.qwen.code.cli.utils.Timeout;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SessionControlRequestTest {
    private static final String REQUEST_ID = "permission-request-1";

    @Test
    void sendsCorrelatedErrorWhenControlHandlerThrows() throws Exception {
        FixtureTransport transport = new FixtureTransport();
        Session session = new Session(transport);

        session.sendPrompt("test", consumers(request -> {
            throw new IllegalStateException("Permission callback failed with token=host-secret");
        }));

        JSONObject response = assertErrorResponse(transport);
        assertEquals("Control request handler failed (IllegalStateException); see SDK logs for details",
                response.getString("error"));
        assertFalse(response.getString("error").contains("host-secret"));
        assertTrue(transport.resultConsumed);
    }

    @Test
    void preservesTheControlHandlerRuntimeExceptionType() throws Exception {
        FixtureTransport transport = new FixtureTransport();
        new Session(transport).sendPrompt("test", consumers(request -> {
            throw new RuntimeException("outer", new IllegalStateException("inner"));
        }));

        assertEquals("Control request handler failed (RuntimeException); see SDK logs for details",
                assertErrorResponse(transport).getString("error"));
        assertTrue(transport.resultConsumed);
    }

    @Test
    void sendsCorrelatedErrorWhenControlHandlerThrowsACyclicCause() {
        FixtureTransport transport = new FixtureTransport();
        RuntimeException first = new RuntimeException("first");
        RuntimeException second = new RuntimeException("second");
        first.initCause(second);
        second.initCause(first);
        FutureTask<Void> read = new FutureTask<>(() -> {
            new Session(transport).sendPrompt("test", consumers(request -> {
                throw first;
            }));
            return null;
        });
        Thread reader = new Thread(read, "cyclic-control-request");
        reader.setDaemon(true);
        try {
            reader.start();
            assertDoesNotThrow(() -> read.get(2, TimeUnit.SECONDS), "A cyclic cause must not wedge the session reader");

            assertEquals("Control request handler failed (RuntimeException); see SDK logs for details",
                    assertErrorResponse(transport).getString("error"));
            assertTrue(transport.resultConsumed);
        } finally {
            read.cancel(true);
        }
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

        assertEquals("Control request handler returned an uncorrelated response: expected request_id="
                + REQUEST_ID + ", got " + requestId, assertErrorResponse(transport).getString("error"));
        assertTrue(transport.resultConsumed);
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {"", "ok"})
    void sendsCorrelatedErrorWhenControlHandlerReturnsAnUnknownSubtype(String subtype) throws Exception {
        FixtureTransport transport = new FixtureTransport();
        CLIControlResponse<ControlResponsePayload> response = success(REQUEST_ID);
        response.getResponse().setSubtype(subtype);
        new Session(transport).sendPrompt("test", consumers(request -> response));

        assertEquals("Control request handler returned an unknown response subtype; expected success or error",
                assertErrorResponse(transport).getString("error"));
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

            assertEquals("Control request handler timed out after 20 milliseconds",
                    assertErrorResponse(transport).getString("error"));
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
    void echoesTheDeserializedControlRequestIdInASuccessResponse() throws Exception {
        FixtureTransport transport = new FixtureTransport();
        new Session(transport).sendPrompt("test", consumers(request -> success(request.getRequestId())));

        assertEquals(1, transport.written.size());
        JSONObject response = JSON.parseObject(transport.written.get(0)).getJSONObject("response");
        assertEquals("success", response.getString("subtype"));
        assertEquals(REQUEST_ID, response.getString("request_id"));
        assertTrue(transport.resultConsumed);
    }

    @Test
    void preservesTheDefaultPermissionProducerResponse() throws Exception {
        FixtureTransport transport = new FixtureTransport();
        SessionEventSimpleConsumers consumers = new SessionEventSimpleConsumers().setAssistantContentConsumer(
                new AssistantContentSimpleConsumers().setDefaultPermissionOperation(Operation.allow));
        new Session(transport).sendPrompt("test", consumers);

        JSONObject payload = assertSuccessResponse(transport).getJSONObject("response");
        assertEquals("allow", payload.getString("behavior"));
        assertNotNull(payload.getJSONObject("updatedInput"));
    }

    @Test
    void preservesTheDefaultOtherControlProducerResponse() throws Exception {
        FixtureTransport transport = new FixtureTransport("interrupt");
        new Session(transport).sendPrompt("test", new SessionEventSimpleConsumers());

        assertTrue(assertSuccessResponse(transport).getJSONObject("response").isEmpty());
    }

    @ParameterizedTest
    @ValueSource(strings = {"can_use_tool", "interrupt"})
    @org.junit.jupiter.api.Timeout(value = 3, unit = TimeUnit.SECONDS)
    void preservesTheDefaultInnerTimeoutFallback(String subtype) throws Exception {
        FixtureTransport transport = new FixtureTransport(subtype);
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        try {
            SessionEventSimpleConsumers consumers = new SessionEventSimpleConsumers(
                    new Timeout(2L, TimeUnit.SECONDS),
                    blockingContentConsumers(entered, release, new Timeout(20L, TimeUnit.MILLISECONDS)));
            new Session(transport).sendPrompt("test", consumers);

            assertTrue(entered.await(1, TimeUnit.SECONDS));
            JSONObject payload = assertSuccessResponse(transport).getJSONObject("response");
            if ("can_use_tool".equals(subtype)) {
                assertEquals("deny", payload.getString("behavior"));
                assertEquals("Default Behavior Permission denied", payload.getString("message"));
            } else {
                assertTrue(payload.isEmpty());
            }
        } finally {
            release.countDown();
        }
    }

    @Test
    @org.junit.jupiter.api.Timeout(value = 3, unit = TimeUnit.SECONDS)
    void reportsTheOuterTimeoutWhileTheDefaultPermissionConsumerIsWaiting() throws Exception {
        FixtureTransport transport = new FixtureTransport();
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        try {
            SessionEventSimpleConsumers consumers = new SessionEventSimpleConsumers(
                    new Timeout(100L, TimeUnit.MILLISECONDS),
                    blockingContentConsumers(entered, release, new Timeout(3L, TimeUnit.SECONDS)));
            new Session(transport).sendPrompt("test", consumers);

            assertTrue(entered.await(1, TimeUnit.SECONDS));
            assertEquals("Control request handler timed out after 100 milliseconds",
                    assertErrorResponse(transport).getString("error"));
            assertTrue(transport.resultConsumed);
        } finally {
            release.countDown();
        }
    }

    private static AssistantContentSimpleConsumers blockingContentConsumers(
            CountDownLatch entered, CountDownLatch release, Timeout timeout) {
        return new AssistantContentSimpleConsumers(Operation.allow, timeout) {
            @Override
            public Behavior onPermissionRequest(Session session, CLIControlPermissionRequest request) {
                awaitRelease(entered, release);
                return super.onPermissionRequest(session, request);
            }

            @Override
            public ControlResponsePayload onOtherControlRequest(Session session, ControlRequestPayload request) {
                awaitRelease(entered, release);
                return new ControlResponsePayload();
            }
        };
    }

    private static void awaitRelease(CountDownLatch entered, CountDownLatch release) {
        entered.countDown();
        try {
            release.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
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

    private static JSONObject assertSuccessResponse(FixtureTransport transport) {
        assertEquals(1, transport.written.size());
        JSONObject envelope = JSON.parseObject(transport.written.get(0));
        assertEquals("control_response", envelope.getString("type"));
        JSONObject response = envelope.getJSONObject("response");
        assertNotNull(response);
        assertEquals(REQUEST_ID, response.getString("request_id"));
        assertEquals("success", response.getString("subtype"));
        assertNotNull(response.getJSONObject("response"));
        assertFalse(response.containsKey("error"));
        assertTrue(transport.resultConsumed);
        return response;
    }

    private static class FixtureTransport implements Transport {
        private final List<String> written = new ArrayList<>();
        private final String requestSubtype;
        private boolean resultConsumed;

        private FixtureTransport() {
            this("can_use_tool");
        }

        private FixtureTransport(String requestSubtype) {
            this.requestSubtype = requestSubtype;
        }

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
            boolean stopped = consumer.apply("{\"type\":\"control_request\",\"request_id\":\"" + REQUEST_ID
                    + "\",\"request\":{\"subtype\":\"" + requestSubtype + "\",\"tool_name\":\"run_shell_command\",\"input\":{}}}");
            if (!stopped) {
                resultConsumed = consumer.apply("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false}");
            }
        }

        @Override
        public void inputNoWaitResponse(String message) {
            written.add(message);
        }
    }
}
