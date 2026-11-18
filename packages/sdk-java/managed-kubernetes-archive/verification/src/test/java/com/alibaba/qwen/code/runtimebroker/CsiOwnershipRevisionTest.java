package com.alibaba.qwen.code.runtimebroker;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CsiOwnershipRevisionTest {
    @Test
    void residentCyclesDoNotExpandTheOriginalPrivateRetirementProtocol() {
        for (long revision : new long[] {0, 2, 4, 6}) {
            assertThat(CsiOwnershipRevision.residentReleased(revision)).isTrue();
            assertThat(CsiOwnershipRevision.residentReserved(revision + 1)).isTrue();
            assertThat(CsiOwnershipRevision.reserved(revision + 1)).isEqualTo(revision == 0);
            assertThat(CsiOwnershipRevision.released(revision)).isEqualTo(revision == 0);
        }
        assertThat(CsiOwnershipRevision.draining(2)).isTrue();
        assertThatThrownBy(() -> CsiOwnershipRevision.next(2)).isInstanceOf(IllegalArgumentException.class);
        assertThat(CsiOwnershipRevision.residentReserved(-1)).isFalse();
        assertThat(CsiOwnershipRevision.residentReleased(-2)).isFalse();
    }
}
