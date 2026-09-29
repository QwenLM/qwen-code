package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.jupiter.api.Test;

class ManagedToolResultProjectorTest {
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
