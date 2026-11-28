package com.alibaba.qwen.code.runtimebroker.http;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import jakarta.servlet.AsyncContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.DependsOn;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

@RestController
@DependsOn("embeddedRuntimeBroker")
@ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker", name = "enabled", havingValue = "true")
public final class RuntimeBrokerHttpController implements AutoCloseable {
    public static final String ROUTE_PREFIX = RuntimeBrokerHttpProtocol.ROUTE_PREFIX;
    private final RuntimeBrokerHttpProtocol protocol;
    private final Set<BrokerHttpExchange> exchanges = ConcurrentHashMap.newKeySet();
    private final AtomicBoolean closing = new AtomicBoolean();

    public RuntimeBrokerHttpController(ManagedAgentProperties properties,
            RuntimeBrokerService service) {
        this.protocol = new RuntimeBrokerHttpProtocol(
                properties.getRuntimeBroker().getToken(), service);
    }

    @RequestMapping({ROUTE_PREFIX, ROUTE_PREFIX + "/**"})
    public void accept(HttpServletRequest request, HttpServletResponse response) throws IOException {
        AsyncContext async = request.startAsync();
        // Existing client and operation deadlines govern completion; do not
        // introduce the container's shorter default asynchronous timeout.
        async.setTimeout(0);
        ServletExchange exchange = new ServletExchange(request, response, async);
        exchanges.add(exchange);
        if (closing.get()) {
            RuntimeBrokerHttpProtocol.unavailable(exchange);
        } else {
            protocol.accept(exchange);
        }
    }

    @Override
    public void close() {
        closing.set(true);
        for (BrokerHttpExchange exchange : exchanges) {
            RuntimeBrokerHttpProtocol.unavailable(exchange);
        }
        protocol.close();
    }

    static String wireState(ToolExecutionRecord.State state) {
        return RuntimeBrokerHttpProtocol.wireState(state);
    }

    private final class ServletExchange implements BrokerHttpExchange {
        private final HttpServletRequest request;
        private final HttpServletResponse response;
        private final AsyncContext async;
        private final AtomicBoolean closed = new AtomicBoolean();

        private ServletExchange(HttpServletRequest request,
                HttpServletResponse response, AsyncContext async) {
            this.request = request;
            this.response = response;
            this.async = async;
        }

        @Override
        public URI getRequestURI() {
            String query = request.getQueryString();
            return URI.create(request.getRequestURI()
                    + (query == null ? "" : "?" + query));
        }

        @Override
        public String getRequestMethod() {
            return request.getMethod();
        }

        @Override
        public String getRequestHeader(String name) {
            return request.getHeader(name);
        }

        @Override
        public void setResponseHeader(String name, String value) {
            if (!closed.get()) {
                response.setHeader(name, value);
            }
        }

        @Override
        public InputStream getRequestBody() throws IOException {
            if (closed.get()) {
                throw new IOException("Response is closed");
            }
            return request.getInputStream();
        }

        @Override
        public OutputStream getResponseBody() throws IOException {
            if (closed.get()) {
                throw new IOException("Response is closed");
            }
            return response.getOutputStream();
        }

        @Override
        public void sendResponseHeaders(int status, long contentLength) throws IOException {
            if (closed.get()) {
                throw new IOException("Response is closed");
            }
            response.setStatus(status);
            response.setContentLengthLong(contentLength);
        }

        @Override
        public void close() {
            if (closed.compareAndSet(false, true)) {
                exchanges.remove(this);
                try {
                    async.complete();
                } catch (IllegalStateException ignored) {
                    // The container has already completed or failed the exchange.
                }
            }
        }
    }
}
