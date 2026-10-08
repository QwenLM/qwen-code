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

    static void requireStoppedRelease(RuntimeBindingRecord binding, RuntimeBindingRecord claim,
            RuntimeSessionRecord session, java.time.Instant now) {
        requireRelease(binding, session);
        if (!binding.sameIdentity(claim) || !binding.getRequest().isManagedContext()
                || !"local-process".equals(binding.getRequest().getProvisionerKind())
                || !"session".equals(binding.getRequest().getScope().getIsolationClass())
                || !binding.getRequest().getIsolationKey().equals(session.getSession().getHarnessSessionId())
                || session.getState() != RuntimeSessionRecord.State.RELEASING
                || binding.getState() != RuntimeBindingRecord.State.DRAINING || !binding.isDrainRequested()
                || binding.getDrainReceipt() == null || !binding.getDrainReceipt().matches(binding)
                || !binding.getDrainReceipt().equals(claim.getDrainReceipt())
                || !java.util.Objects.equals(binding.getResourceHandle(), claim.getResourceHandle())
                || binding.getLease() == null || claim.getLease() == null
                || !binding.getLease().getRuntimeInstanceId().equals(claim.getLease().getRuntimeInstanceId())
                || !binding.getLease().getEndpoint().equals(claim.getLease().getEndpoint())
                || !binding.getLease().getToken().equals(claim.getLease().getToken())
                || !binding.getLease().getLeaseId().equals(claim.getLease().getLeaseId())
                || binding.getLease().getEpoch() != claim.getLease().getEpoch()
                || claim.getOperationOwner() == null
                || !claim.getOperationOwner().equals(binding.getOperationOwner())
                || claim.getOperationGeneration() != binding.getOperationGeneration()
                || !binding.hasLiveOperationAt(now)) {
            throw new RuntimeBrokerException(503, "runtime_close_claim_pending",
                    "Original stopped Session release was fenced", true);
        }
    }
}
