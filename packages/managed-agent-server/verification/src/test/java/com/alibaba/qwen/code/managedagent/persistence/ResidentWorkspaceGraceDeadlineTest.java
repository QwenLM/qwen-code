package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

class ResidentWorkspaceGraceDeadlineTest {
    private ResidentRetirementFixture fixture;

    @BeforeEach
    void setUp() {
        fixture = new ResidentRetirementFixture(new DriverManagerDataSource(
                "jdbc:h2:mem:resident-grace-" + UUID.randomUUID()
                        + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", ""));
        fixture.ready();
    }

    @Test
    void normalCleanupCanFinishBeforeTheGraceDeadline() {
        var api = prepared();
        fixture.completePlatform();
        var metadata = map(fixture.objects.get("pods").get("metadata"));
        metadata.put("deletionTimestamp", Instant.now().plusSeconds(27).toString());
        metadata.put("deletionGracePeriodSeconds", 30);
        RuntimeException refusal = null;
        try {
            new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).reclaim(fixture.request, api);
        } catch (RuntimeException failure) {
            refusal = failure;
        }
        if (refusal != null) {
            assertThat(fixture.store().inspect(fixture.request).state()).isEqualTo("DRAINING");
            assertThat(fixture.storage.inspect(fixture.mapping.registration()).phase()).isEqualTo("RESERVED");
        }
        assertThat(refusal).as("Original container and volume cleanup completed before the future grace deadline").isNull();
        assertThat(fixture.store().inspect(fixture.request).state()).isEqualTo("RELEASED");
    }

    @Test
    void savedCleanupAllowsTheApiToShortenTheDeletionTimestamp() {
        var api = prepared();
        fixture.completePlatform();
        var metadata = map(fixture.objects.get("pods").get("metadata"));
        metadata.put("deletionTimestamp", Instant.now().plusSeconds(27).toString());
        metadata.put("deletionGracePeriodSeconds", 30);
        var podReads = new AtomicInteger();
        when(api.get(eq("pods"), anyString(), anyString())).thenAnswer(call -> {
            if (podReads.incrementAndGet() == 2) {
                metadata.put("deletionTimestamp", Instant.now().toString());
                metadata.put("deletionGracePeriodSeconds", 0);
                metadata.put("resourceVersion", "12");
            }
            return CompletableFuture.completedFuture(fixture.objects.get("pods"));
        });
        RuntimeException refusal = null;
        try {
            new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).reclaim(fixture.request, api);
        } catch (RuntimeException failure) {
            refusal = failure;
        }
        if (refusal != null) {
            assertThat(podReads).hasValue(2);
            assertThat(fixture.store().inspect(fixture.request).state()).isEqualTo("PLATFORM_CLEANED");
            assertThat(fixture.storage.inspect(fixture.mapping.registration()).phase()).isEqualTo("RESERVED");
        }
        assertThat(refusal).as("Saved cleanup receipt remains valid after same-Pod grace shortening").isNull();
        assertThat(fixture.store().inspect(fixture.request).state()).isEqualTo("RELEASED");
    }

    private com.alibaba.qwen.code.runtimebroker.provisioning.KubernetesHttpRuntimeClient prepared() {
        fixture.preparePlatform();
        fixture.store().begin(fixture.request);
        var api = fixture.api();
        new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).prepareReclamation(fixture.request, "10", api);
        new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, "11", api);
        return api;
    }
}
