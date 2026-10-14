package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The post-commit gate's statistic contract, without a broker. Synthetic
 * 225-sample pairs (the gate's retained count) pin the properties the #14197
 * incident and its review established: the incident's recorded arm levels
 * breach the budget, an identical-noise control whose one-arm pauses land on
 * disjoint rounds stays green, a uniform per-round cost goes red, and a
 * stalled tail in one arm alone — the shape that flipped the p95 of the
 * per-round growth — no longer decides the verdict.
 */
class EventTransportBrokerGateStatisticsTest {
    private static final int SAMPLES = 225;
    private static final long BUDGET = Duration.ofMillis(1).toNanos();
    // The recorded #14197 incident: hubDeliveryP95Micros {on: 2040, off: 72}.
    private static final long INCIDENT_ON_NANOS = 2_040_740;
    private static final long INCIDENT_OFF_NANOS = 72_144;

    @Test
    void theRecordedIncidentShapeBreachesTheBudget() {
        List<Long> on = Collections.nCopies(SAMPLES, INCIDENT_ON_NANOS);
        List<Long> off = Collections.nCopies(SAMPLES, INCIDENT_OFF_NANOS);

        List<Long> growth = EventTransportBrokerGate.deltas(on, off, 0);

        assertThat(EventTransportBrokerGate.p95(on)).isEqualTo(INCIDENT_ON_NANOS);
        assertThat(EventTransportBrokerGate.p95(off)).isEqualTo(INCIDENT_OFF_NANOS);
        assertThat(EventTransportBrokerGate.median(growth))
                .as("median growth of the incident's recorded arm levels")
                .isGreaterThan(BUDGET);
    }

    @Test
    void identicalNoisyArmsWithDisjointPausesStayGreen() {
        List<Long> on = new ArrayList<>(Collections.nCopies(SAMPLES, 20_000L));
        List<Long> off = new ArrayList<>(Collections.nCopies(SAMPLES, 20_000L));
        for (int index = 0; index < 15; index++) {
            on.set(index, on.get(index) + 2_000_000);
            off.set(index + 15, off.get(index + 15) + 2_000_000);
        }

        List<Long> growth = EventTransportBrokerGate.deltas(on, off, 0);

        assertThat(EventTransportBrokerGate.p95(growth))
                .as("p95 of the growth still sees the disjoint pauses")
                .isGreaterThan(BUDGET);
        assertThat(EventTransportBrokerGate.median(growth))
                .as("median growth of identical noisy arms")
                .isLessThanOrEqualTo(BUDGET);
    }

    @Test
    void aUniformPerRoundCostGoesRed() {
        List<Long> on = new ArrayList<>(Collections.nCopies(SAMPLES, 20_000L));
        List<Long> off = Collections.nCopies(SAMPLES, 20_000L);
        for (int index = 0; index < SAMPLES; index++) {
            on.set(index, on.get(index) + 2_000_000);
        }

        List<Long> growth = EventTransportBrokerGate.deltas(on, off, 0);

        assertThat(EventTransportBrokerGate.median(growth))
                .as("median growth of a uniform +2 ms per-round cost")
                .isGreaterThan(BUDGET);
    }

    @Test
    void aStalledTailInOneArmStaysGreen() {
        // Twelve one-arm stalls of 225 samples is exactly the p95 boundary:
        // the p95 of the growth trips on it, the median does not.
        List<Long> on = new ArrayList<>(
                Collections.nCopies(SAMPLES, INCIDENT_OFF_NANOS));
        List<Long> off = Collections.nCopies(SAMPLES, INCIDENT_OFF_NANOS);
        for (int index = 0; index < 12; index++) {
            on.set(index, INCIDENT_ON_NANOS);
        }

        List<Long> growth = EventTransportBrokerGate.deltas(on, off, 0);

        assertThat(EventTransportBrokerGate.median(growth))
                .as("median growth with a twelve-round one-arm stall tail")
                .isLessThanOrEqualTo(BUDGET);
        assertThat(EventTransportBrokerGate.p95(growth))
                .as("p95 of the same growth still trips on the tail")
                .isGreaterThan(BUDGET);
        assertThat(EventTransportBrokerGate.roundsOverBudget(growth, BUDGET))
                .isEqualTo(12);
    }

    @Test
    void theRecordKeysNameTheirStatistics() {
        assertThat(EventTransportBrokerGate.armMicros(
                Collections.nCopies(SAMPLES, 20_000L), 0).keySet())
                .containsExactly("p50", "p95", "p99", "max");
        assertThat(EventTransportBrokerGate.growthMicros(
                Collections.nCopies(SAMPLES, 20_000L), BUDGET).keySet())
                .containsExactly("median", "p95", "roundsOverBudget");
    }
}
