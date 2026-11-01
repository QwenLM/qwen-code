package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolHoldRow;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * The durable hold inventory of a Harness Session: the runtime Session ids
 * still owed the close's drain. A hold row (a background Shell process or a
 * Monitor watch) exists — terminal or not — and the Runtime Session's
 * release was never durably recorded. A hold row settling (the run exited,
 * the watch stopped) discharges nothing on its own; only the Session's
 * RELEASED record does. Read-only: a reloaded Harness asks this to restore
 * the close's drain obligation after a restart — restore, never discharge
 * (#13930 R1-2).
 *
 * <p>Extracted from {@link RuntimeBrokerService} as the tool-hold seam. The
 * service keeps the admission, tenant resolution and error-mapping
 * boundary; this class owns the durable pagination and the release filter,
 * and has no lifecycle of its own.
 */
final class RuntimeHoldInventory {
    private final ToolExecutionRepository executionRepository;
    private final RuntimeSessionRepository sessionRepository;

    RuntimeHoldInventory(ToolExecutionRepository executionRepository,
            RuntimeSessionRepository sessionRepository) {
        this.executionRepository = executionRepository;
        this.sessionRepository = sessionRepository;
    }

    List<String> activeRuntimeSessionIds(String harnessSessionId, String tenantId) {
        Set<String> candidates = new LinkedHashSet<>();
        String after = null;
        for (;;) {
            List<ToolHoldRow> batch = executionRepository
                    .findHoldRowsByHarnessSession(harnessSessionId, after, 100);
            for (ToolHoldRow row : batch) {
                candidates.add(row.runtimeSessionId());
            }
            if (batch.size() < 100) {
                break;
            }
            after = batch.get(batch.size() - 1).executionCallId();
        }
        Set<String> released = new LinkedHashSet<>();
        List<String> ids = List.copyOf(candidates);
        for (int from = 0; from < ids.size(); from += 100) {
            for (RuntimeSessionRecord session : sessionRepository.findHistoricalByIds(
                    tenantId, harnessSessionId,
                    ids.subList(from, Math.min(from + 100, ids.size())))) {
                if (session.getState() == RuntimeSessionRecord.State.RELEASED) {
                    released.add(session.getRuntimeSessionId());
                }
            }
        }
        List<String> held = new ArrayList<>();
        for (String runtimeSessionId : candidates) {
            // A missing record is not a durably recorded release either.
            if (!released.contains(runtimeSessionId)) {
                held.add(runtimeSessionId);
            }
        }
        return List.copyOf(held);
    }
}
