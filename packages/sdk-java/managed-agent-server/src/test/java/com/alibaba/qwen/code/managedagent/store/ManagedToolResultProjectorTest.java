package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

class ManagedToolResultProjectorTest {
    @Test
    void disabledTickDoesNoWorkAndEnabledTickStopsAfterEightClaims() {
        var store = org.mockito.Mockito.mock(ManagedToolResultStore.class);
        var properties = new com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties();
        var factory = new org.springframework.beans.factory.support.StaticListableBeanFactory();
        var projector =
                org.mockito.Mockito.spy(
                        new ManagedToolResultProjector(
                                store,
                                org.mockito.Mockito.mock(
                                        org.springframework.jdbc.core.JdbcTemplate.class),
                                factory.getBeanProvider(ToolPublicationDataStore.class),
                                org.mockito.Mockito.mock(ManagedArtifactReader.class),
                                org.mockito.Mockito.mock(
                                        com.alibaba.qwen.code.managedagent.service
                                                .ManagedArtifactPolicy.class),
                                properties));
        projector.tick();
        org.mockito.Mockito.verifyNoInteractions(store);
        var claim = new ManagedToolResultStore.Claim(null, 1);
        org.mockito.Mockito.when(store.claim()).thenReturn(java.util.Optional.of(claim));
        org.mockito.Mockito.doNothing().when(projector).project(claim);
        properties.getArtifacts().setEnabled(true);
        projector.tick();
        org.mockito.Mockito.verify(store).backfillOnePage();
        org.mockito.Mockito.verify(store, org.mockito.Mockito.times(8)).claim();
        org.mockito.Mockito.verify(projector, org.mockito.Mockito.times(8)).project(claim);
    }

    @Test
    void limitsDecodedInvalidUtf8ByEncodedBytesWithoutSplittingCharacters() {
        byte[] raw = new byte[4096];
        Arrays.fill(raw, (byte) 0xff);
        String decoded = new String(raw, StandardCharsets.UTF_8);
        assertThat(decoded.getBytes(StandardCharsets.UTF_8)).hasSize(12288);
        String preview = ManagedToolResultProjector.boundPreview(decoded);
        assertThat(preview.getBytes(StandardCharsets.UTF_8)).hasSize(8190);
        assertThat(preview).isEqualTo("\ufffd".repeat(2730));
        assertThat(ManagedToolResultProjector.boundPreview("a".repeat(8190) + "😀"))
                .isEqualTo("a".repeat(8190));
    }

    @Test
    void stripsTerminalEscapeFamiliesWithoutRemovingVisibleTextOrLineBreaks() {
        assertThat(ManagedToolResultProjector.sanitizePreview("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007"))
                .isEqualTo("link");
        assertThat(ManagedToolResultProjector.sanitizePreview("\u001b]0;title\u001b\\body\n\t"))
                .isEqualTo("body\n\t");
        assertThat(ManagedToolResultProjector.sanitizePreview("\u001bP1$rpayload\u001b\\\u001b7body\u001b(B"))
                .isEqualTo("body");
        assertThat(ManagedToolResultProjector.sanitizePreview("\u009b31mred\u009b0m\u009d0;title\u009c"))
                .isEqualTo("red");
    }

    @Test
    void boundsLinesIndependentlyOfBytes() {
        String output = "line\n".repeat(300);
        String preview = ManagedToolResultProjector.boundPreview(output);
        assertThat(preview.lines().count()).isEqualTo(200);
        assertThat(preview).isEqualTo("line\n".repeat(199) + "line");
    }

    @Test
    void scopedIdentityEncodingIsStableAndUnambiguous() {
        assertThat(ManagedToolResultStore.identity("result", "1", "tenant-1", "workspace-1", "session-1", "execution-1"))
                .isEqualTo("result_2cfafc7d888110d51e955a9816b826fe3fd617141bbf38748bf6116b0efc5d69");
        assertThat(ManagedToolResultStore.identity("result", "1", "a", "bc"))
                .isNotEqualTo(ManagedToolResultStore.identity("result", "1", "ab", "c"));
    }
}
