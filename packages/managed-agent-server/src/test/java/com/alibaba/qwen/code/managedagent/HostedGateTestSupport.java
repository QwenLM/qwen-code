package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.daemon.DaemonEvent;
import com.alibaba.qwen.code.daemon.HarnessEventStream;
import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.StreamHarnessEvents;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.service.HarnessEventProjector;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ProjectedEvent;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.Ordered;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

import java.net.URI;
import java.security.Principal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

// #14147: the helpers the hosted gate probes and ITs used to carry as
// per-class private copies (the FG6e/FG8/FG10a rounds; see
// docs/design/2026-10-17-hosted-gate-shared-helpers.md). Per-letter
// mechanics — the relay's loop control, the fault arms, the case
// choreography — stay in the letters; only the byte-identical machinery
// lives here.
final class HostedGateTestSupport {
    private static final ObjectMapper JSON = new ObjectMapper();

    private HostedGateTestSupport() {
    }

    // The tenant-pinned authentication filter (FG6e's and FG8's probes
    // carried it verbatim apart from the fixture name;
    // HostedPublicWorkspaceIT's header-driven variant is a different
    // mechanism — per-request actor — and stays there).
    static FilterRegistrationBean<Filter> authentication(String tenant,
            String fixtureName) {
        AuthenticatedTenantActor actor = new AuthenticatedTenantActor() {
            public String tenantId() {
                return tenant;
            }

            public String actorId() {
                return "actor";
            }

            public String getName() {
                return fixtureName;
            }
        };
        FilterRegistrationBean<Filter> registration =
                new FilterRegistrationBean<>((request, response, chain) ->
                        chain.doFilter(new HttpServletRequestWrapper(
                                (HttpServletRequest) request) {
                            @Override
                            public Principal getUserPrincipal() {
                                return actor;
                            }
                        }, response));
        registration.setOrder(Ordered.HIGHEST_PRECEDENCE);
        registration.setAsyncSupported(true);
        registration.setDispatcherTypes(DispatcherType.REQUEST,
                DispatcherType.ASYNC);
        registration.addUrlPatterns("/v1/agents/*",
                "/api/agent/web-shell/v1/*");
        return registration;
    }

    // The relay's shared mechanics: the fixture-tokened client, the boot-id
    // capability check, the parseSession reflection bridge, and the event
    // stream built from the Session's own resume cursors. The probes keep
    // the loop control (FG6e's terminal latch, FG8's stop-and-close).
    record RelayStream(HostedHarnessClient client, HarnessSessionRef ref,
            HarnessEventStream stream) implements AutoCloseable {
        @Override
        public void close() throws Exception {
            // Multi-resource semantics, preserved from the probes' nested
            // try-with-resources: a failing stream close (a
            // DaemonTransportException from the underlying input) must
            // still close the client, or its scheduler, heartbeat and
            // HTTP executors never shut down.
            try {
                stream.close();
            } finally {
                client.close();
            }
        }
    }

    static RelayStream openRelayStream(JsonNode request, String sessionId,
            String parseDescription) {
        var client = HostedHarnessClient.builder()
                .baseUri(URI.create(request.path("baseUrl").asText()))
                .bearerToken("hosted-process-fixture-token")
                .capabilityDigest("sha256:" + "a".repeat(64)).build();
        try {
            assertThat(client.capabilities().getBootId())
                    .isEqualTo(request.path("bootId").asText());
            HarnessSessionRef ref = ReflectionTestUtils.invokeMethod(client,
                    "parseSession", request.path("created").toString(),
                    sessionId, parseDescription);
            var stream = client.streamEvents(StreamHarnessEvents.builder()
                    .session(ref).lastEventId(ref.getHarnessLastEventId())
                    .eventEpoch(ref.getHarnessEventEpoch()).build());
            return new RelayStream(client, ref, stream);
        } catch (Throwable error) {
            try {
                client.close();
            } catch (Throwable closeError) {
                error.addSuppressed(closeError);
            }
            throw error;
        }
    }

    static ProjectedEvent projectEvent(HarnessEventProjector projector,
            DaemonEvent event, String turnId) {
        return projector.project(
                new SourceEvent(event.getId(), event.getType(),
                        event.getData(), event.getPromptId(),
                        event.getMetadata()),
                turnId);
    }

    // The append with the relay's idempotency key shape. Returns the key.
    static String appendProjected(ManagedAgentStore store, String tenant,
            String sessionId, RelayStream relay, DaemonEvent event,
            ProjectedEvent projected, String turnId) {
        String key = relay.ref().getHarnessBootId() + ":"
                + relay.stream().getEventEpoch() + ":" + event.getId();
        store.appendPublicEventIfAbsent(tenant, sessionId, turnId,
                projected.type(), projected.data(), projected.terminal(),
                key);
        return key;
    }

    // The 16 tool-publication property lines the publication fixtures tune.
    static List<String> toolPublicationArgs(int servicePort, String bucket,
            long executionBytes) {
        return List.of(
                "--qwen.managed-agent.tool-publication.enabled=true",
                "--qwen.managed-agent.tool-publication.oss-endpoint=https://oss-cn-hangzhou.aliyuncs.com",
                "--qwen.managed-agent.tool-publication.oss-region=cn-hangzhou",
                "--qwen.managed-agent.tool-publication.oss-bucket=" + bucket,
                "--qwen.managed-agent.tool-publication.service-base-url=http://127.0.0.1:"
                        + servicePort,
                "--qwen.managed-agent.tool-publication.execution-bytes="
                        + executionBytes,
                "--qwen.managed-agent.tool-publication.session-bytes=1073741824",
                "--qwen.managed-agent.tool-publication.tenant-bytes=1073741824",
                "--qwen.managed-agent.tool-publication.active-captures=4",
                "--qwen.managed-agent.tool-publication.entry-concurrency=4",
                "--qwen.managed-agent.tool-publication.operation-timeout=10s",
                "--qwen.managed-agent.tool-publication.claim-timeout=5s",
                "--qwen.managed-agent.tool-publication.verification-bytes-per-second=1048576",
                "--qwen.managed-agent.tool-publication.max-verification-timeout=20m",
                "--qwen.managed-agent.tool-publication.gc-enabled=true",
                "--qwen.managed-agent.tool-publication.deletion-grace=0s");
    }

    // The OSS stub both publication fixtures wire, with the union of their
    // method sets: the in-memory object arms serve the IT that really
    // publishes; a fixture that never publishes (FG8) simply never calls
    // them, and any other method still throws, naming the fixture.
    static void stubPublicationOss(ConfigurableApplicationContext context,
            Map<String, byte[]> objects, String fixtureName) {
        var acl = new com.aliyun.oss.model.AccessControlList();
        acl.setCannedACL(com.aliyun.oss.model.CannedAccessControlList.Private);
        var oss = org.mockito.Mockito.mock(com.aliyun.oss.OSS.class,
                invocation -> switch (invocation.getMethod().getName()) {
                    case "getBucketVersioning" ->
                        new com.aliyun.oss.model.BucketVersioningConfiguration();
                    case "getBucketAcl" -> acl;
                    case "putObject" -> {
                        var put = (com.aliyun.oss.model.PutObjectRequest)
                                invocation.getArgument(0);
                        byte[] bytes = put.getInputStream().readAllBytes();
                        if (objects.putIfAbsent(put.getKey(), bytes)
                                != null) {
                            throw new com.aliyun.oss.OSSException(
                                    "Object already exists",
                                    "FileAlreadyExists", "request", "host",
                                    put.getBucketName(), put.getKey(),
                                    "resource");
                        }
                        yield new com.aliyun.oss.model.PutObjectResult();
                    }
                    case "getObject" -> {
                        byte[] bytes = objects.get(
                                invocation.<String>getArgument(1));
                        if (bytes == null) {
                            throw new com.aliyun.oss.OSSException(
                                    "Object not found", "NoSuchKey",
                                    "request", "host",
                                    invocation.getArgument(0),
                                    invocation.getArgument(1), "resource");
                        }
                        var object = new com.aliyun.oss.model.OSSObject();
                        object.setObjectContent(
                                new java.io.ByteArrayInputStream(bytes));
                        yield object;
                    }
                    case "deleteObject" -> {
                        objects.remove(invocation.<String>getArgument(1));
                        yield null;
                    }
                    case "shutdown" -> null;
                    case "toString" -> fixtureName;
                    default -> throw new AssertionError(
                            "Unexpected OSS access in " + fixtureName + ": "
                                    + invocation.getMethod().getName());
                });
        context.addBeanFactoryPostProcessor(beanFactory -> beanFactory
                .registerSingleton("toolPublicationOss", oss));
    }

    // The extension-record JDBC read, led by the Session's scope key: the
    // unindexed tenant+session-only form scans every byte the lane has
    // written so far, so the record read leads with the same key.
    static List<JsonNode> extensionRecords(JdbcTemplate jdbc, String tenant,
            String sessionId, String domain) {
        try {
            String scope = ManagedSessionStore.sessionScopeKey(tenant,
                    sessionId);
            var rows = jdbc.queryForList(
                    "SELECT record_id, record_resource_id FROM"
                            + " ma_session_record WHERE session_scope_key = ?"
                            + " AND tenant_id = ? AND session_id = ? AND"
                            + " domain = ? ORDER BY gmt_create, record_id",
                    scope, tenant, sessionId, domain);
            var records = new ArrayList<JsonNode>();
            for (var row : rows) {
                var resources = jdbc.queryForList(
                        "SELECT CONVERT(inline_bytes USING utf8mb4) AS body"
                                + " FROM ma_resource WHERE session_scope_key"
                                + " = ? AND resource_id = ? AND tenant_id = ?"
                                + " AND session_id = ?", scope,
                        row.get("record_resource_id"), tenant, sessionId);
                assertThat(resources).as(domain + " record body").hasSize(1);
                records.add(JSON.readTree(
                        resources.getFirst().get("body").toString()));
            }
            return records;
        } catch (java.io.IOException error) {
            throw new IllegalStateException(error);
        }
    }

    static JsonNode extensionRecord(JdbcTemplate jdbc, String tenant,
            String sessionId, String domain) {
        var records = extensionRecords(jdbc, tenant, sessionId, domain);
        assertThat(records).as(domain + " records").hasSize(1);
        return records.getFirst();
    }
}
