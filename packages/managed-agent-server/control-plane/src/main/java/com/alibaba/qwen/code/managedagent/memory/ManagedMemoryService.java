package com.alibaba.qwen.code.managedagent.memory;

import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Query;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Result;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryProvider;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Service
public class ManagedMemoryService {
    private final MemoryRepository repository;
    private final MemoryProvider provider;

    public ManagedMemoryService(MemoryRepository repository, MemoryProvider provider) {
        this.repository = repository;
        this.provider = provider;
    }

    public Result query(String tenant, String session, String writerToken, Query query) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Memory provider calls require a fresh transaction.");
        }
        query.validate();
        var admission = repository.admit(tenant, session, writerToken, query);
        if (admission.replay() != null) {
            return admission.replay();
        }
        return repository.complete(admission, provider.execute(admission.namespace(), query));
    }
}
