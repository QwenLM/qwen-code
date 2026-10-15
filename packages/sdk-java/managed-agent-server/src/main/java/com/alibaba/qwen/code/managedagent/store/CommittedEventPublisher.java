package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;

import java.util.List;

/**
 * After-commit publication port of the store; the sole bean is
 * CompositeCommittedEventPublisher in the service package. EventTransport
 * deliberately mirrors this signature for the distribution-adapter role — a
 * change to the publication contract must be made in both files.
 */
public interface CommittedEventPublisher {
    void publish(List<EventRecord> events);
}
