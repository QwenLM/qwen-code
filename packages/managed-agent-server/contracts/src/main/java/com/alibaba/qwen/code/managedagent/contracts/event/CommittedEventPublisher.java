package com.alibaba.qwen.code.managedagent.contracts.event;

import com.alibaba.qwen.code.managedagent.model.StoreModels.EventRecord;

import java.util.List;

/**
 * After-commit publication port of the store; the sole bean is
 * CompositeCommittedEventPublisher in the service package. EventTransport
 * deliberately mirrors this signature for the distribution-adapter role — a
 * change to the publication contract must be made in both files.
 */
public interface CommittedEventPublisher {
    public void publish(List<EventRecord> events);
}
