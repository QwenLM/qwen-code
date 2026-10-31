package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.daemon.DaemonEvent;
import com.alibaba.qwen.code.daemon.HarnessEventStream;
import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.daemon.StreamHarnessEvents;
import com.alibaba.qwen.code.managedagent.adapters.artifact.AliyunObjectStoreClient;
import com.alibaba.qwen.code.managedagent.api.AuthenticatedTenantActor;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ProjectedEvent;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.session.HarnessEventProjector;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.Filter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.Ordered;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.ReflectionUtils;

import java.lang.reflect.Field;
import java.net.URI;
import java.security.Principal;
import java.time.Duration;
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
public final class HostedGateTestSupport {
    private static final ObjectMapper JSON = new ObjectMapper();

    private HostedGateTestSupport() {
    }

    // A Hosted IT advertises ports it probed by binding an ephemeral port
    // and closing it again. Anything that binds in between -- a MySQL
    // connection's local port, a worker left by an earlier test in the same
    // fork, a neighbour process on a shared host -- can take the number back,
    // and the application's own bind then fails with "Address already in
    // use". That is the boot failure recorded on the Hook reload, extensions
    // and MCP restart gates across nightly runs. Probe again and retry a
    // bounded number of times instead of trusting a port the OS may already
    // have handed out; a bind conflict is the only retried failure.
    static ConfigurableApplicationContext bootWithFreshPorts(Runnable probe,
            java.util.function.Supplier<ConfigurableApplicationContext> boot) {
        for (int attempt = 1; ; attempt++) {
            probe.run();
            try {
                return boot.get();
            } catch (RuntimeException error) {
                if (attempt == 3 || !bindConflict(error)) {
                    throw error;
                }
            }
        }
    }

    private static boolean bindConflict(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof java.net.BindException) {
                return true;
            }
        }
        return false;
    }

    static String quote(String text) {
        return "'" + text.replace("'", "'\"'\"'") + "'";
    }

    static String camel(String key) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < key.length(); i++) {
            char c = key.charAt(i);
            if (c == '_' && i + 1 < key.length()) {
                out.append(Character.toUpperCase(key.charAt(++i)));
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    // Keep a newly admitted close invisible until the fixture owns its claim.
    static OperationRecord admitAndClaimClose(TransactionTemplate transactions,
            ManagedAgentStore store, String tenant, String sessionId,
            String key, String owner) {
        return transactions.execute(ignored -> {
            var admission = store.beginWorkspaceLifecycle(tenant, sessionId,
                    OperationKind.CLOSE, "actor", DigestUtils.sha256Hex("actor"),
                    key, "sha256:" + DigestUtils.sha256Hex(key), true, 2);
            return store.claimOperation(tenant, sessionId,
                    admission.operation().operationId(), owner,
                    Duration.ofMinutes(10)).orElseThrow();
        });
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
    // A publication fixture may fault the physical write. `beforePut` runs
    // before the object is stored; `afterPut` runs after it but before the
    // caller sees the ack, so a committed object can be paired with a lost
    // acknowledgement without adding a second store implementation.
    interface PublicationFaults {
        default void beforePut(String key, byte[] bytes) {
        }

        default void afterPut(String key, byte[] bytes) {
        }
    }

    static void stubPublicationOss(ConfigurableApplicationContext context,
            Map<String, byte[]> objects, String fixtureName) {
        stubPublicationOss(context, objects, fixtureName, null);
    }

    static void stubPublicationOss(ConfigurableApplicationContext context,
            Map<String, byte[]> objects, String fixtureName,
            PublicationFaults faults) {
        stubPublicationOss(context, objects, fixtureName, faults, null);
    }

    static void stubPublicationOss(ConfigurableApplicationContext context,
            Map<String, byte[]> objects, String fixtureName,
            PublicationFaults faults, Map<String, Integer> putCounts) {
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
                        if (putCounts != null) {
                            putCounts.merge(put.getKey(), 1, Integer::sum);
                        }
                        if (faults != null) {
                            faults.beforePut(put.getKey(), bytes);
                        }
                        if (objects.putIfAbsent(put.getKey(), bytes)
                                != null) {
                            throw new com.aliyun.oss.OSSException(
                                    "Object already exists",
                                    "FileAlreadyExists", "request", "host",
                                    put.getBucketName(), put.getKey(),
                                    "resource");
                        }
                        if (faults != null) {
                            faults.afterPut(put.getKey(), bytes);
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
                .registerSingleton("toolPublicationOss", new AliyunObjectStoreClient(oss)));
    }

    // The extension-record JDBC read, led by the Session's scope key: the
    // unindexed tenant+session-only form scans every byte the lane has
    // written so far, so the record read leads with the same key.
    static List<JsonNode> extensionRecords(JdbcTemplate jdbc, String tenant,
            String sessionId, String domain) {
        try {
            String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant,
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

    // The Harness-private routes identify the caller by the client id its
    // attach minted and the process generation it attached to; the connector
    // keeps both on its private attachment ref for the Session. Null when
    // Spring holds no attachment to it.
    static HarnessSessionRef attachment(HarnessConnector connector,
            String sessionId) {
        for (Object value : attachmentsOf(connector).values()) {
            if (value instanceof HarnessSessionRef ref
                    && sessionId.equals(ref.getHarnessSessionId())) {
                return ref;
            }
        }
        return null;
    }

    // The bean Spring hands out can be a decorator around the connector that
    // owns the private state these gates read, so resolve the owner once and
    // let every read share it. A chain that owns no attachment map stops at
    // its last connector, so the caller's getField still names the missing
    // field instead of failing somewhere less obvious. A delegate that is
    // itself null falls back to the connector we started from, for the same
    // reason: getField(null, …) complains about the missing target instead of
    // naming the field the caller asked for.
    public static HarnessConnector connectorOwning(HarnessConnector connector) {
        HarnessConnector owner = connector;
        while (owner != null && declaredField(owner, "attachments", Map.class) == null) {
            Field delegate = declaredField(owner, "delegate", HarnessConnector.class);
            if (delegate == null) {
                break;
            }
            ReflectionUtils.makeAccessible(delegate);
            owner = (HarnessConnector) ReflectionUtils.getField(delegate, owner);
        }
        return owner != null ? owner : connector;
    }

    static Map<?, ?> attachmentsOf(HarnessConnector connector) {
        return (Map<?, ?>) ReflectionTestUtils.getField(
                connectorOwning(connector), "attachments");
    }

    // findField's type argument matches the declared type exactly, not by
    // assignability, so a delegate declared as a concrete connector would be
    // missed. Match on the name and check assignability instead. A field that
    // exists and holds null is still a field: the caller reads its value.
    private static Field declaredField(HarnessConnector owner, String name,
            Class<?> type) {
        Field field = ReflectionUtils.findField(owner.getClass(), name);
        return field != null && type.isAssignableFrom(field.getType()) ? field : null;
    }
}
