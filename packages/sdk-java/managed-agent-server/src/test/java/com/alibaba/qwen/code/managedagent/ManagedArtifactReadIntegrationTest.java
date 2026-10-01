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
                .readRange(any(), anyLong(), anyInt(), any(Runnable.class));
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
                        return permission.get();
                    }
                };
        var reader = spy(fixture.reader());
        doAnswer(
                        invocation -> {
                            var input = (java.io.InputStream) invocation.callRealMethod();
                            return new java.io.FilterInputStream(input) {
                                public int read(byte[] bytes, int offset, int length)
                                        throws java.io.IOException {
                                    return super.read(bytes, offset, Math.min(1, length));
                                }
                            };
                        })
                .when(reader)
                .open(any(), any(Runnable.class));
        var response = spy(new org.springframework.mock.web.MockHttpServletResponse());
        var output = spy(response.getOutputStream());
        org.mockito.Mockito.doReturn(output).when(response).getOutputStream();
        doAnswer(
                        invocation -> {
                            invocation.callRealMethod();
                            if (deleteSession) {
                                fixture.jdbc()
                                        .update(
                                                "UPDATE managed_agent_session SET status ="
                                                    + " 'DELETING'");
                            } else {
                                permission.set(false);
                            }
                            return null;
                        })
                .when(output)
                .write(any(byte[].class), anyInt(), anyInt());
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
