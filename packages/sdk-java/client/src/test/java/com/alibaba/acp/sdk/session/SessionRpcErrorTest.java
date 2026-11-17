package com.alibaba.acp.sdk.session;

import com.alibaba.acp.sdk.AcpClient;
import com.alibaba.acp.sdk.protocol.agent.response.PromptResponse.PromptResponseResult;
import com.alibaba.acp.sdk.protocol.client.request.LoadSessionRequest.LoadSessionRequestParams;
import com.alibaba.acp.sdk.protocol.domain.content.block.TextContent;
import com.alibaba.acp.sdk.session.event.consumer.AgentEventConsumer;
import com.alibaba.acp.sdk.session.event.consumer.PromptEndEventConsumer;
import com.alibaba.acp.sdk.session.exception.SessionLoadException;
import com.alibaba.acp.sdk.transport.Transport;
import com.alibaba.acp.sdk.transport.process.ProcessTransport;
import com.alibaba.acp.sdk.transport.process.ProcessTransportOptions;
import com.alibaba.acp.sdk.utils.Timeout;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.util.Collections;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SessionRpcErrorTest {
    @Test
    void rejectsAnExplicitSessionLoadError() throws Exception {
        AcpClient client = new AcpClient(new LoadTransport("error"));

        SessionLoadException failure = assertThrows(SessionLoadException.class,
                () -> client.loadSession(parameters()));

        assertTrue(failure.getMessage().contains("fixture unknown session"));
        assertTrue(failure.getMessage().contains("-32602"));
    }

    @Test
    void acceptsASuccessfulSessionLoad() throws Exception {
        AcpClient client = new AcpClient(new LoadTransport("success"));

        assertNotNull(client.loadSession(parameters()));
    }

    @Test
    void preservesSessionLoadTransportFailures() throws Exception {
        LoadTransport transport = new LoadTransport("io");
        AcpClient client = new AcpClient(transport);

        SessionLoadException failure = assertThrows(SessionLoadException.class,
                () -> client.loadSession(parameters()));

        assertSame(transport.failure, failure.getCause());
    }

    @Test
    void propagatesThePromptErrorThroughTheRealProcessTransport() throws Exception {
        AtomicInteger ended = new AtomicInteger();
        IOException failure = assertThrows(IOException.class, () -> prompt("error", ended));

        assertTrue(failure.getMessage().contains("fixture provider unavailable"));
        assertTrue(failure.getMessage().contains("-32603"));
        assertEquals(0, ended.get());
    }

    @Test
    void acceptsASuccessfulPrompt() throws Exception {
        AtomicInteger ended = new AtomicInteger();

        prompt("success", ended);

        assertEquals(1, ended.get());
    }

    @Test
    void anUnrelatedErrorDoesNotEndTheActivePrompt() throws Exception {
        AtomicInteger ended = new AtomicInteger();

        prompt("unrelated-error", ended);

        assertEquals(1, ended.get());
    }

    private static LoadSessionRequestParams parameters() {
        return new LoadSessionRequestParams().setSessionId("fixture-session");
    }

    private static void prompt(String mode, AtomicInteger ended) throws Exception {
        String classpath = Paths.get(SessionRpcErrorTest.class.getProtectionDomain().getCodeSource().getLocation().toURI())
                + File.pathSeparator + Paths.get(JSON.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        String executable = Paths.get(System.getProperty("java.home"), "bin", "java").toString();
        PeerTransport transport = new PeerTransport(new String[] {executable, "-cp", classpath, AgentPeer.class.getName(), mode});
        transport.start();
        try {
            AgentEventConsumer consumer = new AgentEventConsumer().setPromptEndEventConsumer(new PromptEndEventConsumer() {
                @Override
                public void onPromptEnd(PromptResponseResult result) {
                    ended.incrementAndGet();
                }

                @Override
                public Timeout onPromptEndTimeout(PromptResponseResult result) {
                    return new Timeout(1L, TimeUnit.SECONDS);
                }
            });
            new Session(transport, parameters()).sendPrompt(Collections.singletonList(new TextContent("ordinary prompt")), consumer);
        } finally {
            transport.finish();
        }
    }

    private static final class PeerTransport extends ProcessTransport {
        private PeerTransport(String[] command) {
            super(new ProcessTransportOptions().setCommandArgs(command)
                    .setTurnTimeout(new Timeout(5L, TimeUnit.SECONDS))
                    .setMessageTimeout(new Timeout(5L, TimeUnit.SECONDS)));
        }

        private void finish() throws Exception {
            process.destroyForcibly();
            assertTrue(process.waitFor(5, TimeUnit.SECONDS));
            close();
        }
    }

    public static final class AgentPeer {
        public static void main(String[] args) throws IOException {
            BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            JSONObject request = JSON.parseObject(input.readLine());
            if ("unrelated-error".equals(args[0])) {
                System.out.println(response("another-request", true));
            }
            System.out.println(response(request.get("id"), "error".equals(args[0])));
        }

        private static JSONObject response(Object id, boolean error) {
            JSONObject response = new JSONObject();
            response.put("jsonrpc", "2.0");
            response.put("id", id);
            if (error) {
                JSONObject details = new JSONObject();
                details.put("code", -32603);
                details.put("message", "fixture provider unavailable");
                response.put("error", details);
            } else {
                response.put("result", Collections.singletonMap("stopReason", "end_turn"));
            }
            return response;
        }
    }

    private static final class LoadTransport implements Transport {
        private final String mode;
        private final IOException failure = new IOException("fixture transport error");

        private LoadTransport(String mode) {
            this.mode = mode;
        }

        @Override
        public boolean isReading() { return false; }

        @Override
        public void start() {}

        @Override
        public void close() {}

        @Override
        public boolean isAvailable() { return true; }

        @Override
        public String inputWaitForOneLine(String message) throws IOException {
            JSONObject request = JSON.parseObject(message);
            boolean loading = "session/load".equals(request.getString("method"));
            if (loading && "io".equals(mode)) {
                throw failure;
            }
            JSONObject response = new JSONObject();
            response.put("jsonrpc", "2.0");
            response.put("id", request.get("id"));
            if (loading && "error".equals(mode)) {
                JSONObject error = new JSONObject();
                error.put("code", -32602);
                error.put("message", "fixture unknown session");
                response.put("error", error);
            } else {
                response.put("result", loading ? new JSONObject() : Collections.singletonMap("protocolVersion", 1));
            }
            return response.toString();
        }

        @Override
        public void inputWaitForMultiLine(String message, Function<String, Boolean> callback) {
            throw new AssertionError("Unexpected prompt in load fixture");
        }

        @Override
        public void inputNoWaitResponse(String message) {
            throw new AssertionError("Unexpected notification in load fixture");
        }
    }
}
