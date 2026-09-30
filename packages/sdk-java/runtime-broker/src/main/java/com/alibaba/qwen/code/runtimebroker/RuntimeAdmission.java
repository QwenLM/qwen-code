package com.alibaba.qwen.code.runtimebroker;

/** Checks performed while the parent generation admission lock is held. */
final class RuntimeAdmission {
    private RuntimeAdmission() {
    }

    static void requireReady(RuntimeBindingRecord binding, long generation) {
        if (binding == null || binding.getGeneration() != generation
                || binding.getState() != RuntimeBindingRecord.State.READY
                || binding.isDrainRequested()) {
            throw new RuntimeBrokerException(409, "runtime_admission_closed",
                    "Runtime generation no longer accepts new operations", false);
        }
    }

    static void requireRelease(RuntimeBindingRecord binding, RuntimeSessionRecord session) {
        if (binding == null || !binding.getBindingId().equals(session.getBindingId())
                || binding.getGeneration() != session.getRuntimeGeneration()
                || !binding.getRequest().getScope().equals(session.getSession().getScope())
                || binding.getState() != RuntimeBindingRecord.State.READY
                        && binding.getState() != RuntimeBindingRecord.State.DRAINING
                        && (binding.getRequest().isManagedContext() || !binding.hasStoppedWriters())) {
            throw new RuntimeBrokerException(503, "runtime_reconciliation_required",
                    "Runtime release requires recovery of the original generation", true);
        }
    }

    static void requireSession(RuntimeSessionRecord session,
            ToolExecutionRecord execution) {
        if (session == null
                || session.getState() != RuntimeSessionRecord.State.READY
                || !session.getBindingId().equals(execution.getBindingId())
                || session.getRuntimeGeneration() != execution.getRuntimeGeneration()
                || !session.getSession().getHarnessSessionId().equals(
                        execution.getHarnessSessionId())) {
            throw new RuntimeBrokerException(409, "runtime_admission_closed",
                    "Runtime Session no longer accepts new operations", false);
        }
    }
}
