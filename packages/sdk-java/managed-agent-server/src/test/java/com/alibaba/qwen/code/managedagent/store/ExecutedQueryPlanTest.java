package com.alibaba.qwen.code.managedagent.store;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ExecutedQueryPlanTest {
    @Test
    void multipliesActualMariaDbRowsByLoopsAndUsesOnlyTheChosenIndex() {
        var plan = ExecutedQueryPlan.mariaDb("""
                {"query_block":{"nested_loop":[
                  {"table":{"table_name":"r","access_type":"ref",
                    "possible_keys":["unused"],"key":"chosen",
                    "rows":10000,"r_rows":2,"r_loops":3,"r_filtered":0}},
                  {"table":{"table_name":"l","access_type":"eq_ref","key":"PRIMARY",
                    "rows":1,"r_rows":0.5,"r_loops":4}}
                ]}}
                """);
        assertThat(plan.rowCounts()).containsExactly(6d, 2d);
        assertThat(plan.scannedRows()).isEqualTo(8);
        assertThat(plan.usesIndex("chosen")).isTrue();
        assertThat(plan.usesIndex("unused")).isFalse();
        assertThat(plan.tableScan()).isFalse();
    }

    @Test
    void doesNotHideLargeScansBehindEstimatesOrFiltering() {
        var plan = ExecutedQueryPlan.mariaDb("""
                {"query_block":{"table":{"table_name":"history","access_type":"ALL",
                  "rows":1,"r_rows":10000,"r_loops":2,"r_filtered":0.01}}}
                """);
        assertThat(plan.scannedRows()).isEqualTo(20000);
        assertThat(plan.tableScan()).isTrue();
    }

    @Test
    void refusesEstimatedOnlyPlansAndIncompleteRuntimeCounters() {
        for (String statistics : new String[] {
                "\"rows\":1", "\"r_rows\":2", "\"r_rows\":null,\"r_loops\":1"}) {
            assertThatThrownBy(() -> ExecutedQueryPlan.mariaDb(
                    "{\"table\":{\"table_name\":\"r\",\"access_type\":\"ref\"," + statistics + "}}"))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("Missing actual row/loop statistics");
        }
    }

    @Test
    void preservesZeroLoopsForAnUnexecutedJoinTable() {
        var plan = ExecutedQueryPlan.mariaDb("""
                {"table":{"table_name":"unused","access_type":"ref",
                  "key":"chosen","r_rows":null,"r_loops":0}}
                """);
        assertThat(plan.rowCounts()).containsExactly(0d);
        assertThat(plan.scannedRows()).isZero();
        assertThat(plan.preExecutionPageReads()).isZero();
    }

    @Test
    void keepsOptimizationStagePageReadsSeparateFromRowsAndEstimates() {
        var plan = ExecutedQueryPlan.mariaDb("""
                {"query_block":{"nested_loop":[{"table":{
                  "table_name":"ma_resource","access_type":"const","key":"PRIMARY",
                  "rows":9999,"r_loops":0,"r_rows":null,
                  "r_engine_stats":{"pages_accessed":2}}}]}}
                """);
        assertThat(plan.scannedRows()).isZero();
        assertThat(plan.preExecutionPageReads()).isEqualTo(2);
        assertThat(plan.usesIndex("PRIMARY")).isTrue();
    }

    @Test
    void requiresActualPrimaryConstPageEvidence() {
        for (String access : new String[] {"ref", "const"}) {
            for (String key : new String[] {"another", "PRIMARY"}) {
                for (String pages : new String[] {"null", "0", "\"2\"", "2"}) {
                    var plan = ExecutedQueryPlan.mariaDb("{\"table\":{\"table_name\":\"r\","
                            + "\"access_type\":\"" + access + "\",\"key\":\"" + key + "\","
                            + "\"r_rows\":null,\"r_loops\":0,\"r_engine_stats\":{\"pages_accessed\":" + pages + "}}}");
                    assertThat(plan.scannedRows()).isZero();
                    assertThat(plan.preExecutionPageReads()).isEqualTo(
                            access.equals("const") && key.equals("PRIMARY") && pages.equals("2") ? 2 : 0);
                }
            }
        }
    }

    @Test
    void preservesMySqlTreeOperatorCountsAndScanDetection() {
        var plan = ExecutedQueryPlan.mysql("""
                -> Limit: 3 row(s) (actual time=0.01..0.02 rows=3 loops=1)
                    -> Index lookup on r using chosen (actual time=0.01..0.02 rows=1.5 loops=2)
                """);
        assertThat(plan.rowCounts()).containsExactly(3d, 3d);
        assertThat(plan.scannedRows()).isEqualTo(6);
        assertThat(plan.usesIndex("chosen")).isTrue();
        assertThat(plan.tableScan()).isFalse();
        assertThat(ExecutedQueryPlan.mysql(
                "-> Table scan on r (actual time=0.01..1 rows=10000 loops=1)").tableScan()).isTrue();
    }
}
