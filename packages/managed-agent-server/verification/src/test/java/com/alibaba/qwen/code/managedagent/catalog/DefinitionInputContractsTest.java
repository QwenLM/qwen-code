package com.alibaba.qwen.code.managedagent.catalog;

import com.alibaba.qwen.code.managedagent.contracts.definitions.DefinitionInputMode;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.Context;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.Definition;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.SourceRef;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.ToolPolicy;
import com.alibaba.qwen.code.managedagent.contracts.extensions.AgentBootstrapBundleSource.BundleRef;
import com.alibaba.qwen.code.managedagent.contracts.extensions.AgentBootstrapBundleSource.Download;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class DefinitionInputContractsTest {
    private static final String HASH = "a".repeat(64);

    @Test
    void defaultsToPreRegisteredWhenModeIsUnset() {
        assertThat(DefinitionInputMode.parse("pre-registered"))
                .isEqualTo(DefinitionInputMode.PRE_REGISTERED);
        assertThat(DefinitionInputMode.parse("SPI")).isEqualTo(DefinitionInputMode.SPI);
        assertThatThrownBy(() -> DefinitionInputMode.parse("other"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> DefinitionInputMode.parse("latest"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void rejectsLatestAsRevisionButAcceptsAPreciseProjection() {
        var ref = new SourceRef("catalog", "sales-agent", "da1:7:" + HASH,
                HASH, "workspace-1");
        var definition = new Definition(ref, "model-a", "", new ToolPolicy(
                "hosted-workspace-files/1", "default"), null, null, null);

        assertThat(ref.sourceRevision()).isEqualTo("da1:7:" + HASH);
        assertThat(definition.skills()).isEmpty();
        assertThat(definition.suites()).isEmpty();
        assertThat(definition.bootstrapBundles()).isEmpty();
        assertThatThrownBy(() -> new SourceRef("catalog", "sales-agent", "latest", HASH,
                "workspace-1")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void allowsAnInheritedApprovalMode() {
        assertThat(new ToolPolicy("hosted-workspace-files/1", null).approvalMode()).isNull();
    }

    @Test
    void validatesProviderAndExactBundleInputs() {
        assertThat(new BundleRef("catalog", "skill-17", "17", HASH, 1L)
                .expectedDigest()).isEqualTo(HASH);
        assertThatThrownBy(() -> new BundleRef("UPPER", "skill-17", "17", HASH, 1L))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new BundleRef("catalog", "skill-17", "latest", HASH, 1L))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new BundleRef("catalog", "skill-17", "17", HASH, 0L))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void hidesDownloadCredentialsFromTheRecordRepresentation() {
        Download download = new Download(URI.create("https://objects.example.test/access?token=secret"),
                Instant.parse("2026-11-25T12:00:00Z"), "application/zip");

        assertThat(download.toString()).contains("<redacted>").doesNotContain("secret");
    }

    @Test
    void requiresAnExactScopeAndDeadline() {
        var context = new Context("tenant", "actor", "workspace-1", "workspace-1", "request-1",
                Instant.parse("2026-11-25T12:00:00Z"));

        assertThat(context.executionScope()).isEqualTo("workspace-1");
        assertThatThrownBy(() -> new Context("tenant", "actor", "workspace-1", "", "request-1",
                Instant.now())).isInstanceOf(IllegalArgumentException.class);
    }
}
