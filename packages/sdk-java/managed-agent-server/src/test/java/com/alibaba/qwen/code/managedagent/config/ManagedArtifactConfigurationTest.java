package com.alibaba.qwen.code.managedagent.config;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

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
}
