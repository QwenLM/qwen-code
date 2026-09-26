package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import java.util.List;

public interface CommittedEventPublisher {
    void publish(List<EventRecord> events);
}
