package com.alibaba.qwen.code.managedagent;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The post-commit gate's statistic contract, without a broker. Synthetic
 * pairs at the gate's retained round count pin the properties the #14197
 * incident review established: a uniform per-round cost goes red, an
 * identical-noise control whose one-arm pauses land on disjoint rounds
 * stays green, and a stalled tail in one arm alone — the shape that flipped
 * the p95 of the per-round growth — decides neither the median nor the
 * verdict. The recorded incident itself (hubDeliveryP95Micros {on: 2040,
 * off: 72}) has no unique per-round reconstruction: its pervasive form —
 * every round at the recorded levels — goes red below, its twelve-stall
 * parsimonious form stays green, and the artifact admits no distribution
 * that separates the two, so the incident's arm asymmetry stays an open
 * question this suite does not claim to answer.
 */
class EventTransportBrokerGateStatisticsTest {
    private static final int SAMPLES =
            EventTransportBrokerGate.ROUNDS - EventTransportBrokerGate.ROUNDS / 4;
    private static final long BUDGET =
            EventTransportBrokerGate.GROWTH_BUDGET_NANOS;
    private static final long STALL_BUDGET =
            EventTransportBrokerGate.GROWTH_STALL_BUDGET_NANOS;
    // The recorded #14197 incident: hubDeliveryP95Micros {on: 2040, off: 72}.
    private static final long INCIDENT_ON_NANOS = 2_040_740;
    private static final long INCIDENT_OFF_NANOS = 72_144;
    // The one-arm stall count at the p95 boundary: the p95 of SAMPLES
    // samples is the STALLS-th largest, so one fewer stall leaves it on the
    // floor.
    private static final int STALLS =
            SAMPLES - (int) Math.ceil(SAMPLES * 0.95) + 1;

    @Test
    void theGateRunsAtTheRecordedScale() {
        assertThat(SAMPLES).isEqualTo(225);
        assertThat(STALLS).isEqualTo(12);
        assertThat(BUDGET).isEqualTo(1_000_000);
        assertThat(STALL_BUDGET).isEqualTo(20_000_000);
    }

    @Test
    void thePervasiveIncidentReconstructionGoesRed() {
        // Every round at the recorded arm levels. The removed p95-of-levels
        // form caught this shape too: the median trips because the
        // elevation is pervasive, and nothing here claims the recorded run
        // looked like this.
        List<Long> on = Collections.nCopies(SAMPLES, INCIDENT_ON_NANOS);
        List<Long> off = Collections.nCopies(SAMPLES, INCIDENT_OFF_NANOS);

        List<Long> growth = EventTransportBrokerGate.deltas(on, off, 0);

        assertThat(EventTransportBrokerGate.p95(on)).isEqualTo(INCIDENT_ON_NANOS);
        assertThat(EventTransportBrokerGate.p95(off)).isEqualTo(INCIDENT_OFF_NANOS);
        assertThat(EventTransportBrokerGate.growthWithinBudget(growth, BUDGET))
                .as("the pervasive reconstruction of the recorded levels")
                .isFalse();
    }

    @Test
    void aUniformPerRoundCostGoesRed() {
        List<Long> on = new ArrayList<>(Collections.nCopies(SAMPLES, 20_000L));
        List<Long> off = Collections.nCopies(SAMPLES, 20_000L);
        for (int index = 0; index < SAMPLES; index++) {
            on.set(index, on.get(index) + 2_000_000);
        }

        List<Long> growth = EventTransportBrokerGate.deltas(on, off, 0);

        assertThat(EventTransportBrokerGate.growthWithinBudget(growth, BUDGET))
                .as("a uniform +2 ms per-round cost breaches the gate's"
                        + " own budget in every environment")
                .isFalse();
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
        assertThat(EventTransportBrokerGate.growthWithinBudget(growth, BUDGET))
                .as("identical noisy arms stay within the gate's budget")
                .isTrue();
    }

    @Test
    void aStalledTailInOneArmStaysGreen() {
        // The parsimonious per-round reconstruction of the recorded #14197
        // arm levels: STALLS one-arm stalls of SAMPLES samples is exactly
        // the p95 boundary — the p95 of the growth trips on it, the median
        // does not.
        List<Long> on = new ArrayList<>(
                Collections.nCopies(SAMPLES, INCIDENT_OFF_NANOS));
        List<Long> off = Collections.nCopies(SAMPLES, INCIDENT_OFF_NANOS);
        for (int index = 0; index < STALLS; index++) {
            on.set(index, INCIDENT_ON_NANOS);
        }

        List<Long> growth = EventTransportBrokerGate.deltas(on, off, 0);

        assertThat(EventTransportBrokerGate.p95(on)).isEqualTo(INCIDENT_ON_NANOS);
        assertThat(EventTransportBrokerGate.p95(off)).isEqualTo(INCIDENT_OFF_NANOS);
        assertThat(EventTransportBrokerGate.p95(growth))
                .as("p95 of the growth still trips on the tail")
                .isGreaterThan(BUDGET);
        assertThat(EventTransportBrokerGate.growthWithinBudget(growth, BUDGET))
                .as("a stalled tail in one arm stays within the budget")
                .isTrue();
        assertThat(EventTransportBrokerGate.roundsOverBudget(growth, BUDGET))
                .isEqualTo(STALLS);
        assertThat(EventTransportBrokerGate.roundsOverBudget(growth,
                STALL_BUDGET))
                .as("the recorded incident's stalls stay under the stall"
                        + " budget")
                .isZero();
    }

    @Test
    void aRecurringMinorityBeyondTheFrequencyCapGoesRed() {
        // One over the frequency cap, all in one arm: the median stays on
        // the floor, so only the frequency bound can go red — remove it and
        // this case passes.
        List<Long> on = new ArrayList<>(Collections.nCopies(SAMPLES, 20_000L));
        List<Long> off = Collections.nCopies(SAMPLES, 20_000L);
        for (int index = 0; index < SAMPLES / 10 + 1; index++) {
            on.set(index, on.get(index) + 2_000_000);
        }

        List<Long> growth = EventTransportBrokerGate.deltas(on, off, 0);

        assertThat(EventTransportBrokerGate.median(growth))
                .as("the median alone still passes")
                .isLessThanOrEqualTo(BUDGET);
        assertThat(EventTransportBrokerGate.roundsOverBudget(growth, BUDGET))
                .isEqualTo(SAMPLES / 10 + 1);
        assertThat(EventTransportBrokerGate.growthWithinBudget(growth, BUDGET))
                .as("a recurring minority breaches the frequency bound")
                .isFalse();
    }

    @Test
    void aRecurringMinorityBeyondTheStallBudgetGoesRed() {
        // Exactly at the frequency cap, so the count bound passes, and the
        // median stays on the floor: only the stall budget can go red.
        List<Long> on = new ArrayList<>(Collections.nCopies(SAMPLES, 20_000L));
        List<Long> off = Collections.nCopies(SAMPLES, 20_000L);
        for (int index = 0; index < SAMPLES / 10; index++) {
            on.set(index, on.get(index) + 500_000_000L);
        }

        List<Long> growth = EventTransportBrokerGate.deltas(on, off, 0);

        assertThat(EventTransportBrokerGate.median(growth))
                .as("the median alone still passes")
                .isLessThanOrEqualTo(BUDGET);
        assertThat(EventTransportBrokerGate.roundsOverBudget(growth, BUDGET))
                .as("exactly at the frequency cap")
                .isEqualTo(SAMPLES / 10);
        assertThat(EventTransportBrokerGate.growthWithinBudget(growth, BUDGET))
                .as("a half-second growth in a tenth of the rounds breaches"
                        + " the stall budget")
                .isFalse();
    }

    @Test
    void theWarmUpDiscardDropsThePrefix() {
        int from = EventTransportBrokerGate.ROUNDS / 4;
        List<Long> on = new ArrayList<>(
                Collections.nCopies(EventTransportBrokerGate.ROUNDS, 20_000L));
        List<Long> off =
                Collections.nCopies(EventTransportBrokerGate.ROUNDS, 20_000L);
        on.set(0, 60_000_000L);

        List<Long> growth = EventTransportBrokerGate.deltas(on, off, from);
        Map<String, Long> arm = EventTransportBrokerGate.armMicros(on, from);

        assertThat(growth).hasSize(SAMPLES).containsOnly(0L);
        assertThat(arm.get("max")).isEqualTo(20L);
    }

    @Test
    void theMedianIsTheUpperMiddleSample() {
        assertThat(EventTransportBrokerGate.median(List.of(5L, 1L, 3L)))
                .isEqualTo(3L);
        assertThat(EventTransportBrokerGate.median(List.of(1L, 2L, 3L, 4L)))
                .isEqualTo(3L);
    }

    @Test
    void theRecordKeysNameTheirStatistics() {
        assertThat(EventTransportBrokerGate.armMicros(
                Collections.nCopies(SAMPLES, 20_000L), 0).keySet())
                .containsExactly("p50", "p95", "p99", "max");
        assertThat(EventTransportBrokerGate.growthMicros(
                Collections.nCopies(SAMPLES, 20_000L), BUDGET).keySet())
                .containsExactly("median", "p95", "max", "roundsOverBudget",
                        "budget");
        assertThat(EventTransportBrokerGate.metricMicros(Map.of("on", 1L),
                Map.of("off", 2L), Map.of("growth", 3L)).keySet())
                .containsExactly("on", "off", "growth");
    }

    @Test
    void theRecordReportsTheValuesItsKeysName() {
        Map<String, Long> constant = EventTransportBrokerGate.armMicros(
                Collections.nCopies(SAMPLES, 20_000L), 0);
        assertThat(constant.get("p50")).isEqualTo(20L);
        assertThat(constant.get("p95")).isEqualTo(20L);
        assertThat(constant.get("p99")).isEqualTo(20L);
        assertThat(constant.get("max")).isEqualTo(20L);

        // A two-level list with exactly STALLS high samples separates the
        // p95 (and everything above it) from the p50.
        List<Long> twoLevels =
                new ArrayList<>(Collections.nCopies(SAMPLES, 20_000L));
        for (int index = 0; index < STALLS; index++) {
            twoLevels.set(index, 2_000_000L);
        }
        Map<String, Long> levels =
                EventTransportBrokerGate.armMicros(twoLevels, 0);
        assertThat(levels.get("p50")).isEqualTo(20L);
        assertThat(levels.get("p95")).isEqualTo(2_000L);
        assertThat(levels.get("p99")).isEqualTo(2_000L);
        assertThat(levels.get("max")).isEqualTo(2_000L);

        List<Long> ramp = new ArrayList<>();
        for (long value = 0; value < SAMPLES; value++) {
            ramp.add(value * 1_000);
        }
        Map<String, Long> growth =
                EventTransportBrokerGate.growthMicros(ramp, BUDGET);
        assertThat(growth.get("median")).isEqualTo(112L);
        assertThat(growth.get("p95")).isEqualTo(213L);
        assertThat(growth.get("max")).isEqualTo(224L);
        assertThat(growth.get("roundsOverBudget")).isEqualTo(0L);
        assertThat(growth.get("budget")).isEqualTo(BUDGET / 1000);
    }
}
