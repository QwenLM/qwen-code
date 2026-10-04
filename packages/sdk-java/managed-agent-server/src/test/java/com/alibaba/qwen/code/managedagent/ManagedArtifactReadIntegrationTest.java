package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.spy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.alibaba.qwen.code.managedagent.api.*;
import com.alibaba.qwen.code.managedagent.service.*;
import com.alibaba.qwen.code.managedagent.store.ManagedArtifactReader;
import com.fasterxml.jackson.databind.ObjectMapper;

import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

class ManagedArtifactReadIntegrationTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String ROOT = "/v1/agents/sessions/session-1";

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(ints = {Integer.MAX_VALUE, 4096})
    void fullDownloadUsesOneLeaseAndBoundsQueriesAcrossObjectSegments(int maxRead) throws Exception {
        var h2 = new org.h2.jdbcx.JdbcDataSource();
        h2.setURL("jdbc:h2:mem:download-" + java.util.UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        var statements = new AtomicInteger();
        var admissions = new AtomicInteger();
        var counted = new org.springframework.jdbc.datasource.DelegatingDataSource(h2) {
            @Override public java.sql.Connection getConnection() throws java.sql.SQLException {
                var connection = super.getConnection();
                return (java.sql.Connection) java.lang.reflect.Proxy.newProxyInstance(
                        getClass().getClassLoader(), new Class<?>[] {java.sql.Connection.class},
                        (proxy, method, arguments) -> {
                            if (method.getName().equals("createStatement")) { statements.incrementAndGet(); }
                            if (method.getName().equals("prepareStatement")) {
                                statements.incrementAndGet();
                                if (((String) arguments[0]).startsWith("INSERT INTO qwen_output_read_lease")) {
                                    admissions.incrementAndGet();
                                }
                            }
                            try { return method.invoke(connection, arguments); }
                            catch (java.lang.reflect.InvocationTargetException error) { throw error.getCause(); }
                        });
            }
        };
        int size = 8 * 1024 * 1024;
        var source = new ManagedArtifactApiIntegrationTest();
        source.fixture = ToolPublicationStoreTest.largeApiFixture(size, counted, maxRead);
        source.configureApi();
        var artifact = source.fixture.results().listArtifacts("tenant-1", "session-1", null, null, null, 100)
                .artifacts().stream().filter(row -> row.streamId().equals("stdout")).findFirst().orElseThrow();
        statements.set(0);
        admissions.set(0);
        var response = source.mvc.perform(asReader(get(ROOT + "/artifacts/"
                + artifact.descriptor().path("id").asText() + "/content?revision="
                + artifact.descriptor().path("revision").asText())))
                .andExpect(status().isOk()).andExpect(header().string("Content-Length", Integer.toString(size)))
                .andReturn().getResponse();
        assertThat(statements.get()).isLessThanOrEqualTo(350 * 8);
        assertThat(admissions.get()).isEqualTo(1);
        assertThat(response.getContentAsByteArray()).isEqualTo("A".repeat(size).getBytes(StandardCharsets.UTF_8));
        assertThat(source.fixture.jdbc().queryForObject("SELECT COUNT(*) FROM qwen_output_read_lease", Long.class)).isZero();
    }

    @Test
    void OverlappingReadsRefuseImmediatelyAndTimeoutReleasesPermit() throws Exception {
        var source = new ManagedArtifactApiIntegrationTest();
        source.setup();
        var fixture = source.fixture;
        var sessions = source.sessions;
        var stdout = source.stdout;
        fixture.properties().getArtifacts().setMaxConcurrentReads(1);
        fixture.properties().getArtifacts().setReadTimeout(Duration.ofMillis(80));
        var reader = spy(fixture.reader());
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        doAnswer(
                        invocation -> {
                            entered.countDown();
                            if (!release.await(3, TimeUnit.SECONDS)) {
                                throw new IllegalStateException("release timeout");
                            }
                            return invocation.callRealMethod();
                        })
                .when(reader)
                .readRange(any(), anyLong(), anyInt(), any(com.alibaba.qwen.code.managedagent.store.ToolPublicationRetentionStore.ReadLease.class), any(Runnable.class));
        var mvc =
                mvc(
                        new ManagedArtifactService(
                                sessions,
                                fixture.results(),
                                reader,
                                fixture.policy(),
                                fixture.properties()));
        var route =
                ROOT
                        + "/artifacts/"
                        + stdout.path("id").asText()
                        + "/content?revision="
                        + stdout.path("revision").asText();
        var executor = Executors.newSingleThreadExecutor();
        var first =
                executor.submit(
                        () ->
                                mvc.perform(asReader(get(route)).header("Range", "bytes=0-2"))
                                        .andReturn());
        try {
            assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue();
            mvc.perform(asReader(get(route)).header("Range", "bytes=0-2"))
                    .andExpect(status().isTooManyRequests())
                    .andExpect(jsonPath("$.error.code").value("artifact_read_limit"))
                    .andExpect(header().string("Retry-After", "1"));
            Thread.sleep(100);
            release.countDown();
            assertThat(first.get(3, TimeUnit.SECONDS).getResponse().getStatus()).isEqualTo(503);
            mvc.perform(asReader(get(route)).header("Range", "bytes=0-2"))
                    .andExpect(status().isPartialContent())
                    .andExpect(content().string("abc"));
        } finally {
            release.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void ServiceRevocationStopsRealRangeBeforeBytesAreWritten() throws Exception {
        var source = new ManagedArtifactApiIntegrationTest();
        source.setup();
        var fixture = source.fixture;
        var sessions = source.sessions;
        var stdout = source.stdout;
        AtomicInteger calls = new AtomicInteger();
        ManagedArtifactPolicy policy =
                new ManagedArtifactPolicy() {
                    public String version() {
                        return fixture.policy().version();
                    }

                    public boolean publishOriginal(String t, String w, String s) {
                        return true;
                    }

                    public boolean publishPreview(String t, String w, String s) {
                        return true;
                    }

                    public boolean readOriginal(String t, String a, String w, String s) {
                        return calls.incrementAndGet() < 3;
                    }
                };
        // A zero revalidation window re-verifies access on every chunk.
        fixture.properties().getArtifacts()
                .setReadRevalidationInterval(java.time.Duration.ZERO);
        var mvc =
                mvc(
                        new ManagedArtifactService(
                                sessions,
                                fixture.results(),
                                fixture.reader(),
                                policy,
                                fixture.properties()));
        var route =
                ROOT
                        + "/artifacts/"
                        + stdout.path("id").asText()
                        + "/content?revision="
                        + stdout.path("revision").asText();
        var response =
                mvc.perform(asReader(get(route)).header("Range", "bytes=0-2"))
                        .andExpect(status().isForbidden())
                        .andExpect(jsonPath("$.error.code").value("artifact_content_forbidden"))
                        .andReturn()
                        .getResponse();
        assertThat(response.getHeader("Content-Range")).isNull();
    }

    @Test
    void revocationInsideTheShippedWindowStillShipsARange() throws Exception {
        var source = new ManagedArtifactApiIntegrationTest();
        source.setup();
        var fixture = source.fixture;
        var sessions = source.sessions;
        var stdout = source.stdout;
        AtomicInteger calls = new AtomicInteger();
        var policy = readingPolicy(fixture, () -> calls.incrementAndGet() < 3);
        // The shipped 5s default is left in place: a Range read is a single
        // write inside the armed window, so a revocation landing after
        // admission does not stop the body — the accepted in-window
        // exposure, pinned so the default's behavior is asserted somewhere.
        var mvc =
                mvc(
                        new ManagedArtifactService(
                                sessions,
                                fixture.results(),
                                fixture.reader(),
                                policy,
                                fixture.properties()));
        var route =
                ROOT
                        + "/artifacts/"
                        + stdout.path("id").asText()
                        + "/content?revision="
                        + stdout.path("revision").asText();
        mvc.perform(asReader(get(route)).header("Range", "bytes=0-2"))
                .andExpect(status().isPartialContent())
                .andExpect(content().string("abc"));
        // Admission plus the first guard; the window covered the rest.
        assertThat(calls.get()).isEqualTo(2);
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans = {false, true})
    void midstreamRevocationOrDeletionStopsAfterTheFirstByte(boolean deleteSession)
            throws Exception {
        var source = new ManagedArtifactApiIntegrationTest();
        source.setup();
        var fixture = source.fixture;
        var sessions = source.sessions;
        var stdout = source.stdout;
        var permission = new java.util.concurrent.atomic.AtomicBoolean(true);
        var policy = readingPolicy(fixture, permission::get);
        var reader = oneBytePerReadReader(fixture, 0);
        var response = flippingResponse(() -> {
            if (deleteSession) {
                fixture.jdbc()
                        .update(
                                "UPDATE managed_agent_session SET status ="
                                    + " 'DELETING'");
            } else {
                permission.set(false);
            }
        });
        // A zero revalidation window re-verifies access on every chunk.
        fixture.properties().getArtifacts()
                .setReadRevalidationInterval(java.time.Duration.ZERO);
        var service =
                new ManagedArtifactService(
                        sessions, fixture.results(), reader, policy, fixture.properties());
        Throwable failure =
                org.assertj.core.api.Assertions.catchThrowable(
                        () ->
                                service.content(
                                        new TenantContext("tenant-1", "reader"),
                                        "session-1",
                                        stdout.path("id").asText(),
                                        stdout.path("revision").asText(),
                                        null,
                                        null,
                                        null,
                                        response));
        assertThat(response.getContentAsByteArray()).isEqualTo(new byte[] {'a'});
        assertThat(response.isCommitted()).isTrue();
        assertThat(failure)
                .isInstanceOf(java.io.IOException.class)
                .hasMessage("Artifact stream interrupted");
        // The flipping stub really fired its state change.
        if (deleteSession) {
            assertThat(fixture.jdbc().queryForObject(
                    "SELECT status FROM managed_agent_session"
                            + " WHERE session_id = 'session-1'",
                    String.class)).isEqualTo("DELETING");
        } else {
            assertThat(permission).isFalse();
        }
    }

    @org.junit.jupiter.api.Test
    void midstreamDeletionIsDeferredToTheRevalidationWindow()
            throws Exception {
        var source = new ManagedArtifactApiIntegrationTest();
        source.setup();
        var fixture = source.fixture;
        var sessions = source.sessions;
        var stdout = source.stdout;
        var policy = readingPolicy(fixture, () -> true);
        var reader = oneBytePerReadReader(fixture, 0);
        var response = flippingResponse(() -> fixture.jdbc()
                .update("UPDATE managed_agent_session SET status ="
                        + " 'DELETING'"));
        // A 60s window: the DELETING lifecycle gate is evaluated by the
        // throttled access check, so a stage-1 deletion lands only when the
        // window lapses - here, after the stream has completed.
        fixture.properties().getArtifacts()
                .setReadRevalidationInterval(java.time.Duration.ofSeconds(60));
        var service =
                new ManagedArtifactService(
                        sessions, fixture.results(), reader, policy, fixture.properties());
        Throwable failure =
                org.assertj.core.api.Assertions.catchThrowable(
                        () ->
                                service.content(
                                        new TenantContext("tenant-1", "reader"),
                                        "session-1",
                                        stdout.path("id").asText(),
                                        stdout.path("revision").asText(),
                                        null,
                                        null,
                                        null,
                                        response));
        assertThat(response.getContentAsByteArray())
                .isEqualTo(new byte[] {'a', 'b', 'c'});
        assertThat(failure).isNull();
        // The deferral is real: the stage-1 transition really happened
        // mid-stream, and the window is what let the stream complete.
        assertThat(fixture.jdbc().queryForObject(
                "SELECT status FROM managed_agent_session"
                        + " WHERE session_id = 'session-1'",
                String.class)).isEqualTo("DELETING");
    }

    @org.junit.jupiter.api.Test
    void midstreamRevocationIsToleratedWithinTheRevalidationWindow()
            throws Exception {
        var source = new ManagedArtifactApiIntegrationTest();
        source.setup();
        var fixture = source.fixture;
        var sessions = source.sessions;
        var stdout = source.stdout;
        var calls = new AtomicInteger();
        // Revoked once the window has armed; a third call would fail, and
        // the window must not make it.
        var policy = readingPolicy(fixture, () -> calls.incrementAndGet() <= 2);
        var reader = oneBytePerReadReader(fixture, 0);
        var response = new org.springframework.mock.web.MockHttpServletResponse();
        fixture.properties().getArtifacts()
                .setReadRevalidationInterval(java.time.Duration.ofSeconds(60));
        var service =
                new ManagedArtifactService(
                        sessions, fixture.results(), reader, policy, fixture.properties());
        service.content(
                new TenantContext("tenant-1", "reader"),
                "session-1",
                stdout.path("id").asText(),
                stdout.path("revision").asText(),
                null,
                null,
                null,
                response);
        // The whole content arrives although any access check after the
        // first chunk's revalidation would be denied: the window defers it,
        // so the stream is not re-verified per chunk.
        assertThat(response.getContentAsByteArray())
                .isEqualTo("abc".getBytes(StandardCharsets.UTF_8));
        // Admission plus the first chunk's revalidation; the window covers
        // the remaining chunk reads.
        assertThat(calls.get()).isEqualTo(2);
    }

    @org.junit.jupiter.api.Test
    void midstreamRevocationInterruptsTheStreamOnceTheWindowExpires()
            throws Exception {
        var source = new ManagedArtifactApiIntegrationTest();
        source.setup();
        var fixture = source.fixture;
        var sessions = source.sessions;
        var stdout = source.stdout;
        var permission = new java.util.concurrent.atomic.AtomicBoolean(true);
        var policy = readingPolicy(fixture, permission::get);
        var reader = oneBytePerReadReader(fixture, 1000);
        var response = flippingResponse(() -> permission.set(false));
        // A 3s window armed at open: reads take ~1s each, so the two
        // in-window chunks ship (guards at ~1s and ~2s pass) and the third
        // read ends past the window (>= 3s >= the deadline), where the
        // recheck observes the revocation. The 1000ms margins absorb
        // scheduler stalls; the deny side cannot undershoot because sleeps
        // never finish early.
        fixture.properties().getArtifacts()
                .setReadRevalidationInterval(java.time.Duration.ofMillis(3000));
        var service =
                new ManagedArtifactService(
                        sessions, fixture.results(), reader, policy, fixture.properties());
        Throwable failure =
                org.assertj.core.api.Assertions.catchThrowable(
                        () ->
                                service.content(
                                        new TenantContext("tenant-1", "reader"),
                                        "session-1",
                                        stdout.path("id").asText(),
                                        stdout.path("revision").asText(),
                                        null,
                                        null,
                                        null,
                                        response));
        // Both in-window chunks ship; the stream never completes because
        // the recheck at the window's end denies. Per-chunk
        // re-verification (no window) would ship only the first.
        byte[] delivered = response.getContentAsByteArray();
        assertThat(delivered).isEqualTo(new byte[] {'a', 'b'});
        assertThat(response.isCommitted()).isTrue();
        assertThat(failure)
                .isInstanceOf(java.io.IOException.class)
                .hasMessage("Artifact stream interrupted");
    }

    @Test
    void ForeignScopeCursorAndTrueTwoMiBCaptureRefuseAtHttpBoundary() throws Exception {
        var source = new ManagedArtifactApiIntegrationTest();
        source.setup();
        var mvc = source.mvc;
        var list =
                mvc.perform(asReader(get(ROOT + "/artifacts?limit=1")))
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString();
        var cursor =
                JSON.readTree(
                        Base64.getUrlDecoder()
                                .decode(JSON.readTree(list).path("next_cursor").asText()));
        for (String scope : new String[] {"tenant", "session"}) {
            var changed =
                    ((com.fasterxml.jackson.databind.node.ObjectNode) cursor)
                            .deepCopy()
                            .put(scope, "foreign");
            var encoded =
                    Base64.getUrlEncoder()
                            .withoutPadding()
                            .encodeToString(changed.toString().getBytes(StandardCharsets.UTF_8));
            mvc.perform(asReader(get(ROOT + "/artifacts?cursor=" + encoded)))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.error.code").value("invalid_cursor"));
        }
        var large = ToolPublicationStoreTest.largeApiFixture(2 * 1024 * 1024);
        var fresh = new ManagedArtifactApiIntegrationTest();
        fresh.fixture = large;
        fresh.configureApi();
        var largeMvc = fresh.mvc;
        var stdout =
                large
                        .results()
                        .listArtifacts("tenant-1", "session-1", null, null, null, 100)
                        .artifacts()
                        .stream()
                        .filter(x -> x.streamId().equals("stdout"))
                        .findFirst()
                        .orElseThrow()
                        .descriptor();
        String route =
                ROOT
                        + "/artifacts/"
                        + stdout.path("id").asText()
                        + "/content?revision="
                        + stdout.path("revision").asText();
        largeMvc.perform(asReader(get(route)).header("Range", "bytes=0-1048576"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("range_too_large"));
    }

    @Test
    void BatchPolicyAndAvailabilityStayFreshPerRequestAndR1_31GuardPrecedesIo() throws Exception {
        var source = new ManagedArtifactApiIntegrationTest();
        source.setup();
        var fixture = source.fixture;
        var sessions = source.sessions;
        AtomicInteger lookups = new AtomicInteger(), opens = new AtomicInteger();
        var data =
                org.mockito.Mockito.mock(
                        com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore.class,
                        org.mockito.Mockito.withSettings()
                                .spiedInstance(fixture.publications())
                                .defaultAnswer(
                                        invocation -> {
                                            if (invocation
                                                    .getMethod()
                                                    .getName()
                                                    .equals("referencedPublications")) {
                                                lookups.incrementAndGet();
                                            }
                                            if (invocation
                                                    .getMethod()
                                                    .getName()
                                                    .equals("openReferencedStream")) {
                                                opens.incrementAndGet();
                                            }
                                            return invocation.callRealMethod();
                                        }));
        var beans = new org.springframework.beans.factory.support.StaticListableBeanFactory();
        beans.addBean("publication", data);
        var reader =
                new ManagedArtifactReader(
                        beans.getBeanProvider(
                                com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore
                                        .class));
        AtomicInteger decisions = new AtomicInteger();
        var allowed = new java.util.concurrent.atomic.AtomicBoolean(true);
        ManagedArtifactPolicy policy =
                new ManagedArtifactPolicy() {
                    public String version() {
                        return fixture.policy().version();
                    }

                    public boolean publishOriginal(String t, String w, String s) {
                        return true;
                    }

                    public boolean publishPreview(String t, String w, String s) {
                        return true;
                    }

                    public boolean readOriginal(String t, String a, String w, String s) {
                        decisions.incrementAndGet();
                        return allowed.get();
                    }
                };
        var service =
                new ManagedArtifactService(
                        sessions, fixture.results(), reader, policy, fixture.properties());
        var first = service.page(new TenantContext("tenant-1", "reader"), "session-1", null, 100);
        assertThat(first.data()).hasSize(2);
        assertThat(decisions.get()).isEqualTo(1);
        assertThat(lookups.get()).isEqualTo(1);
        allowed.set(false);
        var second = service.page(new TenantContext("tenant-1", "reader"), "session-1", null, 100);
        assertThat(second.data())
                .allSatisfy(value -> assertThat(value.access().canReadContent()).isFalse());
        assertThat(decisions.get()).isEqualTo(2);
        assertThat(lookups.get()).isEqualTo(2);
        var artifact =
                fixture.results()
                        .listArtifacts("tenant-1", "session-1", null, null, null, 100)
                        .artifacts()
                        .getFirst();
        var refusal =
                org.assertj.core.api.Assertions.catchThrowable(
                        () ->
                                reader.readRange(
                                        artifact,
                                        0,
                                        0,
                                        () -> {
                                            throw new IllegalStateException("revoked before I/O");
                                        }));
        assertThat(refusal).hasMessage("revoked before I/O");
        assertThat(opens.get()).isEqualTo(0);
    }

    @Test
    void auditsDeniedAndCompletedEmptyReadsWithDifferentOutcomes() throws Exception {
        var source = new ManagedArtifactApiIntegrationTest();
        source.setup();
        var logger =
                (ch.qos.logback.classic.Logger)
                        org.slf4j.LoggerFactory.getLogger(ManagedArtifactService.class);
        var appender =
                new ch.qos.logback.core.read.ListAppender<
                        ch.qos.logback.classic.spi.ILoggingEvent>();
        appender.start();
        logger.addAppender(appender);
        try {
            String content = ROOT + "/artifacts/" + source.stdout.path("id").asText() + "/content";
            source.mvc
                    .perform(
                            get(content)
                                    .param("revision", source.stdout.path("revision").asText())
                                    .header(TenantContextFilter.HEADER, "tenant-1")
                                    .principal(actor("metadata-reader")))
                    .andExpect(status().isForbidden());
            source.mvc
                    .perform(
                            asReader(
                                    get(ROOT
                                                    + "/artifacts/"
                                                    + source.stderr.path("id").asText()
                                                    + "/content")
                                            .param(
                                                    "revision",
                                                    source.stderr.path("revision").asText())))
                    .andExpect(status().isOk());
            assertThat(
                            appender.list.stream()
                                    .map(
                                            ch.qos.logback.classic.spi.ILoggingEvent
                                                    ::getFormattedMessage)
                                    .filter(message -> message.startsWith("artifact_read "))
                                    .toList())
                    .hasSize(2)
                    .anySatisfy(message -> assertThat(message).contains("outcome=denied bytes=0"))
                    .anySatisfy(
                            message -> assertThat(message).contains("outcome=completed bytes=0"));
        } finally {
            logger.detachAppender(appender);
            appender.stop();
        }
    }

    private static ManagedArtifactPolicy readingPolicy(
            ToolPublicationStoreTest.ApiFixture fixture,
            java.util.function.BooleanSupplier allowed) {
        return new ManagedArtifactPolicy() {
            public String version() {
                return fixture.policy().version();
            }

            public boolean publishOriginal(String t, String w, String s) {
                return true;
            }

            public boolean publishPreview(String t, String w, String s) {
                return true;
            }

            public boolean readOriginal(String t, String a, String w, String s) {
                return allowed.getAsBoolean();
            }
        };
    }

    private static ManagedArtifactReader oneBytePerReadReader(
            ToolPublicationStoreTest.ApiFixture fixture, long perReadDelayMillis) {
        var reader = spy(fixture.reader());
        doAnswer(
                        invocation -> {
                            var input = (java.io.InputStream) invocation.callRealMethod();
                            return new java.io.FilterInputStream(input) {
                                public int read(byte[] bytes, int offset, int length)
                                        throws java.io.IOException {
                                    if (perReadDelayMillis > 0) {
                                        try {
                                            Thread.sleep(perReadDelayMillis);
                                        } catch (InterruptedException error) {
                                            Thread.currentThread().interrupt();
                                        }
                                    }
                                    return super.read(bytes, offset, Math.min(1, length));
                                }
                            };
                        })
                .when(reader)
                .open(any(), any(), any(Runnable.class));
        return reader;
    }

    private static org.springframework.mock.web.MockHttpServletResponse flippingResponse(
            Runnable onWrite) throws java.io.IOException {
        var response = spy(new org.springframework.mock.web.MockHttpServletResponse());
        var output = spy(response.getOutputStream());
        org.mockito.Mockito.doReturn(output).when(response).getOutputStream();
        doAnswer(
                        invocation -> {
                            invocation.callRealMethod();
                            onWrite.run();
                            return null;
                        })
                .when(output)
                .write(any(byte[].class), anyInt(), anyInt());
        return response;
    }

    private static MockMvc mvc(ManagedArtifactService service) {
        return MockMvcBuilders.standaloneSetup(new ManagedArtifactController(service))
                .setCustomArgumentResolvers(new TenantContextArgumentResolver())
                .setControllerAdvice(new ApiExceptionHandler())
                .addFilters(new RequestIdFilter(), new TenantContextFilter(JSON))
                .build();
    }

    private static MockHttpServletRequestBuilder asReader(MockHttpServletRequestBuilder request) {
        return request.header(TenantContextFilter.HEADER, "tenant-1").principal(actor("reader"));
    }

    private static AuthenticatedTenantActor actor(String name) {
        return new AuthenticatedTenantActor() {
            public String tenantId() {
                return "tenant-1";
            }

            public String actorId() {
                return name;
            }

            public String getName() {
                return name;
            }
        };
    }
}
