package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.provisioning.external.ExternalWorkspaceProvisioner;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * The shared-teardown discriminator: a shared external binding may be torn
 * down only by the storage retirement that fences its storage. A single
 * Session close must keep the refusal.
 */
class RuntimeBindingSessionReleaseTest {
    private static final RuntimeScope SHARED_SCOPE = new RuntimeScope("tenant",
            "workspace", "1", "/workspace",
            WorkspaceExecutionProfile.CAPABILITY_DIGEST, "workspace");

    @Test
    void storageFenceIsTheSharedTeardownDiscriminator() {
        var repository = mock(RuntimeBindingRepository.class);
        when(repository.isStorageFenced("tenant", "workspace", null))
                .thenReturn(false);
        assertThat(RuntimeBindingSessionRelease.storageRetirement(
                binding("workspace"), repository)).isFalse();
        when(repository.isStorageFenced("tenant", "workspace", null))
                .thenReturn(true);
        assertThat(RuntimeBindingSessionRelease.storageRetirement(
                binding("workspace"), repository)).isTrue();
        assertThat(RuntimeBindingSessionRelease.storageRetirement(
                binding(null), repository)).isFalse();
    }

    @Test
    void singleSessionCloseOfASharedExternalBindingStaysRefused() {
        var repository = mock(JdbcRuntimeBindingRepository.class);
        when(repository.isStorageFenced("tenant", "workspace", null))
                .thenReturn(false);
        var release = new RuntimeBindingSessionRelease(
                mock(DataSource.class), repository);
        assertThatThrownBy(() -> release.completeStoppedSessionRelease(
                mock(RuntimeSessionRepository.class),
                mock(ToolExecutionRepository.class), session(), binding("workspace")))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getCode())
                            .isEqualTo("external_workspace_recovery_required");
                    assertThat(error.getStatusCode()).isEqualTo(409);
                });
    }

    @Test
    void fencedStorageRetirementPassesTheRefusal() {
        var repository = mock(JdbcRuntimeBindingRepository.class);
        when(repository.isStorageFenced("tenant", "workspace", null))
                .thenReturn(true);
        var release = new RuntimeBindingSessionRelease(
                mock(DataSource.class), repository);
        // The fenced retirement is admitted past the refusal; with mocked
        // repositories the next guard is the same-DataSource check, so this
        // proves the shared-close refusal no longer fires for the fence.
        assertThatThrownBy(() -> release.completeStoppedSessionRelease(
                mock(RuntimeSessionRepository.class),
                mock(ToolExecutionRepository.class), session(), binding("workspace")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Release requires the same DataSource");
    }

    private static RuntimeBindingRecord binding(String storage) {
        return new RuntimeBindingRecord("binding",
                new RuntimeProvisionRequest(SHARED_SCOPE, null,
                        ExternalWorkspaceProvisioner.KIND, storage),
                null, 1, RuntimeBindingRecord.State.DRAINING, null, true,
                "owner", Instant.now().plusSeconds(60), 1, 1,
                Instant.now(), Instant.now());
    }

    private static RuntimeSessionRecord session() {
        return new RuntimeSessionRecord(new RuntimeSession("harness", "runtime",
                "bootstrap", SHARED_SCOPE), "binding", 1,
                RuntimeSessionRecord.State.RELEASING, 0, Instant.now());
    }
}
