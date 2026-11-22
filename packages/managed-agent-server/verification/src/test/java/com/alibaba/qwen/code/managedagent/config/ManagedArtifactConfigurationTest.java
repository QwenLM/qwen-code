package com.alibaba.qwen.code.managedagent.config;

import org.junit.jupiter.api.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedArtifactConfigurationTest {
    @Test
    void enablingMetadataDoesNotApproveOriginalsOrSharedPreviews() {
        var properties = new ManagedAgentProperties();
        var policy = new ManagedArtifactConfiguration().managedArtifactPolicy(properties);
        assertThat(policy.publishOriginal("tenant", "workspace", "session")).isFalse();
        properties.getArtifacts().setEnabled(true);
        assertThat(policy.publishOriginal("tenant", "workspace", "session")).isFalse();
        assertThat(policy.publishPreview("tenant", "workspace", "session")).isFalse();
        assertThat(policy.readOriginal("tenant", "actor", "workspace", "session")).isFalse();
        properties.getArtifacts().setPublishPreview(true);
        assertThat(policy.publishPreview("tenant", "workspace", "session")).isFalse();
    }

    @Test
    void originalAndSharedPreviewApprovalAreSeparateAndVersioned() {
        var properties = new ManagedAgentProperties();
        var settings = properties.getArtifacts();
        settings.setEnabled(true);
        var policy = new ManagedArtifactConfiguration().managedArtifactPolicy(properties);
        String metadataVersion = policy.version();
        settings.setPublishOriginal(true);
        assertThat(policy.version()).isNotEqualTo(metadataVersion);
        assertThat(policy.publishOriginal("tenant", "workspace", "session")).isTrue();
        assertThat(policy.publishPreview("tenant", "workspace", "session")).isFalse();
        assertThat(policy.readOriginal("tenant", "actor", "workspace", "session")).isTrue();
        assertThat(policy.readOriginal("tenant", "", "workspace", "session")).isFalse();
        assertThat(policy.readOriginal("tenant", null, "workspace", "session")).isFalse();
        String originalVersion = policy.version();
        settings.setPublishPreview(true);
        assertThat(policy.version()).isNotEqualTo(originalVersion);
        assertThat(policy.publishPreview("tenant", "workspace", "session")).isTrue();
        String previewVersion = policy.version();
        settings.setEnabled(false);
        assertThat(policy.version()).isNotEqualTo(previewVersion);
        assertThat(policy.publishOriginal("tenant", "workspace", "session")).isFalse();
        assertThat(policy.readOriginal("tenant", "actor", "workspace", "session")).isFalse();
    }

    @Test
    void theScannerRowPoolNeverInterruptsRowTasksAndClosesWithoutWaiting()
            throws Exception {
        // The scan tick's shutdown contract (#15418): a context close must
        // neither interrupt a row task nor park the close behind the relay's
        // timeouts. It does not promise an in-flight row finishes: nothing
        // awaits (`awaitTerminationSeconds(0)`), so `finished` below holds
        // only because this test awaits termination itself.
        var properties = new ManagedAgentProperties();
        properties.getAutomation().setScannerThreads(3);
        var executor = new ManagedArtifactConfiguration()
                .automationScannerExecutor(properties);
        executor.afterPropertiesSet();
        try {
            assertThat(executor.getCorePoolSize()).isEqualTo(3);
            assertThat(executor.getMaxPoolSize()).isEqualTo(3);
            assertThat(executor.getThreadNamePrefix())
                    .isEqualTo("automation-scan-");
            CountDownLatch started = new CountDownLatch(1);
            AtomicBoolean interrupted = new AtomicBoolean(true);
            AtomicBoolean finished = new AtomicBoolean();
            Future<?> task = executor.submit(() -> {
                started.countDown();
                try {
                    Thread.sleep(2_000);
                    interrupted.set(false);
                    finished.set(true);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            });
            assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
            long closed = System.currentTimeMillis();
            executor.destroy();
            assertThat(System.currentTimeMillis() - closed).isLessThan(1_500);
            assertThat(executor.getThreadPoolExecutor()
                    .awaitTermination(5, TimeUnit.SECONDS)).isTrue();
            assertThat(interrupted).isFalse();
            assertThat(finished).isTrue();
            assertThat(task.isDone()).isTrue();
        } finally {
            executor.getThreadPoolExecutor().shutdownNow();
        }
    }

    @Test
    void theScannerRowPoolStillBootsWithAnUnvalidatedSizeWhileAutomationIsOff() {
        // Automation-off skips the positive-count validation, and the pool
        // is unused while the scanner is off, so a dormant 0 must not crash
        // the context that used to boot fine.
        var properties = new ManagedAgentProperties();
        properties.getAutomation().setScannerThreads(0);
        var executor = new ManagedArtifactConfiguration()
                .automationScannerExecutor(properties);
        assertThat(executor.getCorePoolSize()).isEqualTo(1);
        assertThat(executor.getMaxPoolSize()).isEqualTo(1);
    }
}
