package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.aliyun.oss.ClientBuilderConfiguration;
import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSClientBuilder;
import com.aliyun.oss.OSSException;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

@Timeout(15)
class AliyunToolPublicationReadRetryTest {
    @ParameterizedTest
    @CsvSource({"object,503,SlowDown", "object,503,RequestTimeout", "object,502,HTML",
            "versioning,503,SlowDown", "versioning,502,HTML", "acl,503,SlowDown", "acl,502,HTML"})
    void transientReadsRecoverWithTheRealSdk(String operation, int status, String code) throws Exception {
        try (var fixture = new Fixture(operation, status, code, false)) {
            var objects = fixture.objects();
            try (var input = objects.open("key")) {
                assertThat(input.readAllBytes()).isEqualTo("payload".getBytes(StandardCharsets.UTF_8));
            }
            assertThat(fixture.attempts.get()).isEqualTo(operation.equals("versioning") ? 3 : 2);
        }
    }

    @ParameterizedTest
    @CsvSource({"503,SlowDown,4", "503,RequestTimeout,4", "502,HTML,4",
            "500,InvalidResponse,1", "403,AccessDenied,1", "404,NoSuchKey,1"})
    void exhaustedOrPermanentErrorsPreserveSdkDiagnostics(int status, String code, int attempts)
            throws Exception {
        try (var fixture = new Fixture("object", status, code, true)) {
            var objects = fixture.objects();
            assertThatThrownBy(() -> objects.open("key")).isExactlyInstanceOf(OSSException.class)
                    .satisfies(error -> {
                        var service = (OSSException) error;
                        if (code.equals("HTML")) {
                            assertThat(service.getRequestId()).isNull();
                        } else {
                            assertThat(service.getRequestId()).isEqualTo("fixture-request");
                            assertThat(service.getErrorCode()).isEqualTo(code);
                        }
                    });
            assertThat(fixture.attempts.get()).isEqualTo(attempts);
        }
    }

    @Test
    void expiryAfterFailedGetStopsBeforeAnotherWireRequest() throws Exception {
        try (var fixture = new Fixture("object", 502, "HTML", true)) {
            var objects = fixture.objects();
            var expired = new IllegalStateException("original lease expired");
            assertThatThrownBy(() -> objects.open("key", () -> {
                if (!fixture.live.get()) {
                    throw expired;
                }
            })).isSameAs(expired);
            assertThat(fixture.attempts.get()).isEqualTo(1);
        }
    }

    @Test
    void writeFailureIsNotReplayedByTheSdk() throws Exception {
        try (var fixture = new Fixture("put", 503, "SlowDown", true)) {
            var objects = fixture.objects();
            assertThatThrownBy(() -> objects.putIfAbsent("key", "payload".getBytes(StandardCharsets.UTF_8)))
                    .isExactlyInstanceOf(OSSException.class);
            assertThat(fixture.attempts.get()).isEqualTo(1);
            assertThat(fixture.forbidOverwrite.get()).isTrue();
        }
    }

    private static final class Fixture implements AutoCloseable {
        private final AtomicInteger attempts = new AtomicInteger();
        private final AtomicBoolean live = new AtomicBoolean(true);
        private final AtomicBoolean forbidOverwrite = new AtomicBoolean();
        private final HttpServer server;
        private final OSS client;

        private Fixture(String operation, int status, String code, boolean persistent) throws Exception {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", exchange -> {
                try (exchange) {
                    String query = exchange.getRequestURI().getRawQuery();
                    String kind = exchange.getRequestMethod().equals("PUT") ? "put"
                            : query != null && query.contains("versioning") ? "versioning"
                            : query != null && query.contains("acl") ? "acl" : "object";
                    if (kind.equals("put")) {
                        forbidOverwrite.set("true".equals(exchange.getRequestHeaders()
                                .getFirst("x-oss-forbid-overwrite"))
                                && new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)
                                        .equals("payload"));
                    }
                    boolean fault = kind.equals(operation)
                            && (attempts.incrementAndGet() == 1 || persistent);
                    String body = kind.equals("versioning") ? "<VersioningConfiguration/>"
                            : kind.equals("acl") ? "<AccessControlPolicy><Owner><ID>fixture</ID></Owner>"
                                    + "<AccessControlList><Grant>private</Grant></AccessControlList></AccessControlPolicy>"
                            : "payload";
                    if (fault) {
                        live.set(false);
                        body = code.equals("HTML") ? "<html>bad gateway</html>"
                                : "<Error><Code>" + code + "</Code><Message>fixture</Message>"
                                        + "<RequestId>fixture-request</RequestId><HostId>fixture</HostId></Error>";
                    }
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    exchange.getResponseHeaders().set("x-oss-request-id", "fixture-request");
                    exchange.sendResponseHeaders(fault ? status : 200, bytes.length);
                    exchange.getResponseBody().write(bytes);
                }
            });
            server.start();
            var configuration = new ClientBuilderConfiguration();
            AliyunToolPublicationObjectStore.configureClientRetries(configuration);
            configuration.setSLDEnabled(true);
            configuration.setConnectionTimeout(2000);
            configuration.setSocketTimeout(2000);
            try {
                client = new OSSClientBuilder().build("http://127.0.0.1:" + server.getAddress().getPort(),
                        "fixture-id", "fixture-secret", configuration);
            } catch (RuntimeException error) {
                server.stop(0);
                throw error;
            }
        }

        private AliyunToolPublicationObjectStore objects() {
            return new AliyunToolPublicationObjectStore(client, "fixture-bucket");
        }

        @Override
        public void close() {
            client.shutdown();
            server.stop(0);
        }
    }
}
