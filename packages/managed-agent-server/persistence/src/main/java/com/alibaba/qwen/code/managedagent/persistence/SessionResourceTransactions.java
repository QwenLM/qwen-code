package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStore;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.lang.Nullable;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.function.Supplier;

/** Only SQL callbacks belong here: an incomplete read set rolls back before fetching its next body. */
@Component
public final class SessionResourceTransactions implements com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedResourceAccess {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final SessionResourceBodies bodies;
    private final ToolPublicationRetentionStore retention;
    private final JournalColdStorage journalReader;

    public SessionResourceTransactions(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentTransactionManager") PlatformTransactionManager manager,
            @Nullable ImmutableObjectStore objects) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(manager);
        this.bodies = new SessionResourceBodies(jdbc, objects);
        this.retention = new ToolPublicationRetentionStore(jdbc, manager);
        this.journalReader = new JournalColdStorage(jdbc, manager, objects, null, new com.fasterxml.jackson.databind.ObjectMapper());
    }

    public <T> T read(String tenant, String session, Supplier<T> authorizedSql) {
        return read(tenant, session, transactions, authorizedSql);
    }

    @Override
    public <T> T readSnapshot(String tenant, String session, Supplier<T> authorizedSql) {
        var snapshot = new TransactionTemplate(transactions.getTransactionManager());
        snapshot.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_REPEATABLE_READ);
        snapshot.setReadOnly(true);
        return read(tenant, session, snapshot, authorizedSql);
    }

    <T> T read(String tenant, String session, TransactionTemplate sql, Supplier<T> authorizedSql) {
        return execute(tenant, session, sql, authorizedSql, true);
    }

    <T> T retiring(String tenant, String session, Supplier<T> authorizedSql) {
        return execute(tenant, session, transactions, authorizedSql, false);
    }

    private <T> T execute(String tenant, String session, TransactionTemplate sql, Supplier<T> authorizedSql, boolean checkAfter) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            return authorizedSql.get();
        }
        SessionResourceBodies.requireOutsideTransaction(jdbc);
        var leases = new java.util.LinkedHashMap<String, ToolPublicationRetentionStore.ReadLease>();
        try (var prepared = bodies.prepare()) {
            for (int count = 0; count < 512; count++) {
                try {
                    return sql.execute(status -> {
                        leases.values().forEach(ToolPublicationRetentionStore.ReadLease::checkReadView);
                        T result = authorizedSql.get();
                        if (checkAfter) {
                            leases.values().forEach(ToolPublicationRetentionStore.ReadLease::checkReadView);
                        }
                        return result;
                    });
                } catch (SessionResourceBodies.PreparationRequired missing) {
                    var resource = missing.resource();
                    String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(resource.tenantId(), resource.sessionId());
                    Runnable authorize = prepared.dependencies.get(scope);
                    if (!tenant.equals(resource.tenantId()) || !session.equals(resource.sessionId()) && authorize == null) {
                        throw JournalStoreRows.resourceCorrupt();
                    }
                    if (authorize != null) {
                        authorize.run();
                    }
                    var lease = leases.computeIfAbsent(scope, ignored -> retention.readSessionResources(resource.tenantId(), resource.sessionId()));
                    bodies.prepare(prepared, resource, () -> {
                        lease.check();
                        if (authorize != null) {
                            authorize.run();
                        }
                    });
                }
            }
            throw JournalStoreRows.payloadTooLarge("The Session resource dependency graph exceeds the read budget.");
        } finally {
            leases.values().forEach(ToolPublicationRetentionStore.ReadLease::close);
        }
    }

    public <T> T protectedRead(Supplier<T> authorizedSql, Runnable authorize) {
        if (SessionResourceBodies.hasPrepared()) {
            return authorizedSql.get();
        }
        SessionResourceBodies.requireOutsideTransaction(jdbc);
        var leases = new java.util.LinkedHashMap<String, ToolPublicationRetentionStore.ReadLease>();
        var journals = new java.util.LinkedHashMap<String, com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedJournalAccess.Lease>();
        try (var prepared = bodies.prepare()) {
            for (int count = 0; count < 512; count++) {
                try {
                    authorize.run();
                    leases.values().forEach(ToolPublicationRetentionStore.ReadLease::check);
                    journals.values().forEach(com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedJournalAccess.Lease::check);
                    T result = authorizedSql.get();
                    authorize.run();
                    leases.values().forEach(ToolPublicationRetentionStore.ReadLease::check);
                    journals.values().forEach(com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedJournalAccess.Lease::check);
                    return result;
                } catch (SessionResourceBodies.JournalPreparationRequired missing) {
                    authorize.run();
                    String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(missing.tenant, missing.session);
                    journals.computeIfAbsent(scope, ignored -> journalReader.pinHot(missing.tenant, missing.session));
                    prepared.journals.add(scope);
                } catch (SessionResourceBodies.PreparationRequired missing) {
                    authorize.run();
                    var row = missing.resource();
                    String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(row.tenantId(), row.sessionId());
                    var lease = leases.computeIfAbsent(scope, ignored -> retention.readSessionResources(row.tenantId(), row.sessionId()));
                    bodies.prepare(prepared, row, () -> {
                        lease.check();
                        authorize.run();
                    });
                }
            }
            throw JournalStoreRows.payloadTooLarge("The protected resource inventory exceeds the read budget.");
        } finally {
            journals.values().forEach(com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedJournalAccess.Lease::close);
            leases.values().forEach(ToolPublicationRetentionStore.ReadLease::close);
        }
    }
}
