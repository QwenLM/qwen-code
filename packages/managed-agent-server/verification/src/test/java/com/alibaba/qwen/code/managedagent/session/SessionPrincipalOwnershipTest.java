package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedUserMessageStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionPrincipal;
import com.alibaba.qwen.code.managedagent.repository.ManagedUserMessageStore.Command;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class SessionPrincipalOwnershipTest {
    private static final SessionPrincipal OWNER = SessionPrincipal.of("tenant", "user", "actor-A");

    @Test
    void fullPrincipalOwnsReadsListsAndCreateReplayWithoutClaimingLegacyRows() {
        var f = new Fixture();
        f.tx.executeWithoutResult(status -> {
            String id = f.create(OWNER, "create");
            assertThat(f.service.createSession(OWNER, "create", "qwen-code", null,
                    "private", Map.of(), List.of()).replayed()).isTrue();
            assertThat(f.service.getPublicSession(OWNER, id).id()).isEqualTo(id);
            for (var foreign : List.of(SessionPrincipal.of("tenant", "user", "actor-B"),
                    SessionPrincipal.ofUser("tenant", "user"),
                    SessionPrincipal.of("tenant", "other", "actor-A"),
                    SessionPrincipal.of("other-tenant", "user", "actor-A"))) {
                denied(() -> f.service.getPublicSession(foreign, id));
                assertThat(f.service.listPublicSessions(foreign, null, 1, null, null).data()).isEmpty();
            }
            denied(() -> f.service.createSession(SessionPrincipal.ofUser("tenant", "user"),
                    "create", "qwen-code", null, "changed-body", Map.of(), List.of()));
            f.jdbc.update("DELETE FROM ma_session_principal WHERE tenant_id=? AND session_id=?", "tenant", id);
            denied(() -> f.service.getPublicSession(OWNER, id));
            denied(() -> f.service.createSession(OWNER, "create", "qwen-code", null,
                    "private", Map.of(), List.of()));
            assertThat(f.service.listPublicSessions(OWNER, null, 1, null, null).data()).isEmpty();
        });
    }

    @Test
    void absentPrincipalCannotWriteByBorrowingTheDurableOwner() {
        var f = new Fixture();
        f.tx.executeWithoutResult(status -> {
            String id = f.create(OWNER, "create");
            long events = f.count("ma_public_event");
            long receipts = f.count("ma_request_receipt");
            denied(() -> f.store.insertTurnCommand("tenant", "SUBMIT_TURN", "anonymous",
                    "digest", id, List.of(Map.of("type", "text", "text", "hello")),
                    "payload", (SessionPrincipal) null));
            assertThat(f.count("ma_turn")).isZero();
            assertThat(f.count("ma_public_event")).isEqualTo(events);
            assertThat(f.count("ma_request_receipt")).isEqualTo(receipts);
        });
    }

    @Test
    void actorlessReadCannotBypassTheOwnershipRowButLegacyStaysTenantWide() {
        var f = new Fixture();
        f.tx.executeWithoutResult(status -> {
            String owned = f.create(OWNER, "owned");
            denied(() -> f.service.getPublicSession("tenant", null, owned));
            String legacy = f.service.createSession("tenant", null,
                    "legacy", "qwen-code", null, "shared", Map.of(), List.of())
                    .sessionId();
            assertThat(f.service.getPublicSession("tenant", null, legacy).id())
                    .isEqualTo(legacy);
            assertThat(f.service.getPublicSession(OWNER, legacy).id())
                    .isEqualTo(legacy);
        });
    }

    @Test
    void legacyActorlessSessionStaysReadableByAnActorThePrincipalBoundCannotRepresent() {
        var f = new Fixture();
        f.tx.executeWithoutResult(status -> {
            // `TenantContextFilter` admits up to 512 code points, while a
            // principal caps each component at 512 bytes: 512 CJK characters
            // cannot be represented as one (R7-1). A legacy Session with no
            // ownership row must stay readable for that actor.
            String legacy = f.service.createSession("tenant", null,
                    "legacy", "qwen-code", null, "shared", Map.of(), List.of())
                    .sessionId();
            String longActor = "界".repeat(512);
            assertThat(f.service.getPublicSession("tenant", longActor, legacy).id())
                    .isEqualTo(legacy);
            // The bound side keeps its existing behaviour: the same actor
            // cannot borrow a row-bearing Session.
            String owned = f.create(OWNER, "owned");
            denied(() -> f.service.getPublicSession("tenant", longActor, owned));
            assertThat(f.service.getPublicSession(OWNER, owned).id())
                    .isEqualTo(owned);
        });
    }

    @Test
    void modelAndApprovalOverloadsRejectANullPrincipalExplicitly() {
        var f = new Fixture();
        f.tx.executeWithoutResult(status -> {
            String owned = f.create(OWNER, "owned");
            for (var call : List.<org.junit.jupiter.api.function.Executable>of(
                    () -> f.service.queryWebShellSessionModels(null, owned),
                    () -> f.service.queryWebShellSessionApproval(null, owned),
                    () -> f.service.changeWebShellSessionModel(null, owned,
                            "null-model", "model-a", 1L),
                    () -> f.service.changeWebShellSessionApproval(null, owned,
                            "null-approval", "default", 1L, null, Map.of()))) {
                assertThatThrownBy(call::execute)
                        .isInstanceOfSatisfying(ManagedAgentException.class,
                                error -> assertThat(error.getCode())
                                        .isEqualTo("actor_required"));
            }
        });
    }

    @Test
    void storeRejectsPrincipalFromAnotherTenantBeforeReadingOrCreatingOwnership() {
        var f = new Fixture();
        f.tx.executeWithoutResult(status -> {
            String id = f.create(OWNER, "create");
            var foreign = SessionPrincipal.of("other-tenant", "user", "actor-A");
            assertThat(f.store.ownsSession("tenant", id, foreign)).isFalse();
            denied(() -> f.store.requireSessionOwnership("tenant", id, foreign));
            denied(() -> f.store.insertSessionCommand("tenant", foreign, "CREATE_SESSION",
                    "foreign", "digest", "qwen-code", null, null, List.of(), null));
            assertThat(f.count("ma_session")).isEqualTo(1);
        });
    }

    @Test
    void rollbackDoesNotLeaveOwnershipOrPoisonTheCreationKey() {
        var f = new Fixture();
        assertThatThrownBy(() -> f.tx.executeWithoutResult(status -> {
            f.create(OWNER, "rollback");
            throw new IllegalStateException("rollback");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(f.count("ma_session")).isZero();
        assertThat(f.count("ma_session_principal")).isZero();
        assertThat(f.count("ma_request_receipt")).isZero();
        f.tx.executeWithoutResult(status -> assertThat(f.create(OWNER, "rollback")).isNotBlank());
    }

    @Test
    void actorBearingReadRoutesNeverDowngradeToTheActorlessUser() {
        var f = new Fixture();
        var committedActorSession = new java.util.concurrent.atomic.AtomicReference<String>();
        f.tx.executeWithoutResult(status -> {
            var noActor = SessionPrincipal.ofUser("tenant", "user");
            String id = f.create(noActor, "create");
            var turn = f.service.submitTurn(noActor, "turn", id,
                    List.of(new com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock("text", "private")));
            assertThat(f.service.publicEvents(noActor, id, 0, 10).data()).isNotEmpty();
            denied(() -> f.service.publicEvents(OWNER, id, 0, 10));
            denied(() -> f.service.listPublicTurns(OWNER, id, null, 10));
            denied(() -> f.service.getPublicTurn(OWNER, id, turn.turnId()));
            denied(() -> f.service.listPublicItems(OWNER, id, null, 0, 10));
            String actorSession = f.create(OWNER, "actor-create");
            var actorTurn = f.service.submitTurn(OWNER, "actor-turn", actorSession,
                    List.of(new com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock("text", "actor-private")));
            assertThat(f.service.publicEvents(OWNER, actorSession, 0, 10).data()).isNotEmpty();
            assertThat(f.service.listPublicTurns(OWNER, actorSession, null, 10).data()).hasSize(1);
            assertThat(f.service.getPublicTurn(OWNER, actorSession, actorTurn.turnId()).turnId()).isEqualTo(actorTurn.turnId());
            committedActorSession.set(actorSession);
        });
        // Snapshot reads acquire their own lease; use the ownership gate here
        // so this test does not depend on a separately running projector.
        assertThat(f.service.requireReadableSession(OWNER,
                committedActorSession.get()).sessionId())
                .isEqualTo(committedActorSession.get());
    }

    @Test
    void foreignCommandKeysCannotLeakThroughAnOtherwiseOwnedSession() {
        var f = new Fixture();
        f.tx.executeWithoutResult(status -> {
            String ownerSession = f.create(OWNER, "owner-create");
            var foreign = SessionPrincipal.of("tenant", "user", "actor-B");
            String foreignSession = f.create(foreign, "foreign-create");
            var input = List.of(new com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock("text", "hello"));
            var ownTurn = f.service.submitTurn(OWNER, "shared-submit", ownerSession, input);
            assertThat(f.service.submitTurn(OWNER, "shared-submit", ownerSession, input).replayed()).isTrue();
            String anotherOwnedSession = f.create(OWNER, "owner-second-create");
            assertThatThrownBy(() -> f.service.submitTurn(OWNER, "shared-submit", anotherOwnedSession, input))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
            denied(() -> f.service.submitTurn(foreign, "shared-submit", foreignSession, input));
            var foreignTurn = f.service.submitTurn(foreign, "foreign-submit", foreignSession, input);
            f.service.cancelTurn(OWNER, "shared-cancel", ownerSession, ownTurn.turnId());
            denied(() -> f.service.cancelTurn(foreign, "shared-cancel", foreignSession, foreignTurn.turnId()));
            assertThat(f.jdbc.queryForObject("SELECT status FROM ma_turn WHERE session_id=? AND turn_id=?",
                    String.class, foreignSession, foreignTurn.turnId())).isEqualTo("ACCEPTED");
            assertThat(f.count("ma_turn")).isEqualTo(2);
        });
    }

    @Test
    void actorBearingUserMessagesKeepTheirSubjectThroughQueueDispatch() {
        var f = new Fixture();
        when(f.harness.supportsUserMessageQueue()).thenReturn(true);
        var messages = com.alibaba.qwen.code.managedagent.VerificationFixtures
                .configure(new JdbcManagedUserMessageStore(f.jdbc,
                        new ObjectMapper(), new RequestDigests(),
                        new ManagedUserMessagePolicy(f.store,
                                new RequestDigests(), f.harness,
                                f.workspaces)));
        f.tx.executeWithoutResult(status -> {
            String id = f.create(OWNER, "create");
            var input = List.of(new com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock(
                    "text", "queued"));
            denied(() -> messages.command("tenant", "user", id, "actorless",
                    new Command("submit", null, null, input)));
            var queued = messages.command(OWNER, id, "submit",
                    new Command("submit", null, null, input));
            assertThat(queued.messages()).hasSize(1);
            assertThat(messages.queryMessages(OWNER, id).messages()).hasSize(1);
            denied(() -> messages.queryMessages(
                    SessionPrincipal.of("tenant", "user", "actor-B"), id));

            messages.startNext("tenant", id, f.service::submitTurn);

            assertThat(f.jdbc.queryForObject(
                    "SELECT state FROM ma_user_message WHERE tenant_id = ?"
                            + " AND session_id = ?",
                    String.class, "tenant", id)).isEqualTo("claimed");
            assertThat(f.count("ma_turn")).isEqualTo(1);
        });
    }

    @Test
    void rawActorUnarchiveKeepsTheOwnersAuthority() {
        var f = new Fixture();
        f.tx.executeWithoutResult(status -> {
            String id = f.create(SessionPrincipal.ofUser("tenant", "user"), "create");
            f.jdbc.update("UPDATE ma_session SET status='ARCHIVED' WHERE session_id=?", id);
            // R8-5: the production raw-actor entry passes principal=null;
            // the unbound arm must authorise with the raw actor, not the
            // null principal, or the Session's own owner reads 404.
            assertThat(f.service.unarchiveSession("tenant", "user", "unarchive", id)
                    .replayed()).isFalse();
            // R13-2: the subject-less retry authorises with the raw actor the
            // caller actually carries, so it replays instead of answering the
            // principal arm's 404.
            assertThat(f.service.unarchiveSession("tenant", "user", "unarchive", id)
                    .replayed()).isTrue();
            assertThat(f.jdbc.queryForObject("SELECT status FROM ma_session WHERE session_id=?",
                    String.class, id)).isNotEqualTo("ARCHIVED");
        });
    }

    @Test
    void renameAndUnarchiveCheckReceiptSessionInsideAdmission() {
        var f = new Fixture();
        f.tx.executeWithoutResult(status -> {
            String id = f.create(OWNER, "owner-create");
            var other = SessionPrincipal.of("tenant", "user", "actor-B");
            String otherId = f.create(other, "other-create");
            when(f.harness.supportsFencedTitles()).thenReturn(true);
            when(f.harness.createOrLoad("tenant", id, false, true))
                    .thenReturn(new HarnessConnector.Attachment("boot", null, 0L, "epoch"));
            assertThat(f.service.renameSession(OWNER, "rename", id, "private-title").replayed()).isFalse();
            assertThat(f.service.renameSession(OWNER, "rename", id, "private-title").replayed()).isTrue();
            denied(() -> f.service.renameSession(other, "rename", otherId, "private-title"));
            f.jdbc.update("UPDATE ma_session SET status='ARCHIVED' WHERE session_id IN (?, ?)", id, otherId);
            assertThat(f.service.unarchiveSession(OWNER, "unarchive", id).replayed()).isFalse();
            assertThat(f.service.unarchiveSession(OWNER, "unarchive", id).replayed()).isTrue();
            denied(() -> f.service.unarchiveSession(other, "unarchive", otherId));
            assertThat(f.jdbc.queryForObject("SELECT status FROM ma_session WHERE session_id=?", String.class, otherId))
                    .isEqualTo("ARCHIVED");
            denied(() -> f.store.beginSessionRename("tenant", "null-owner", "digest", otherId, "title"));
        });
    }

    @Test
    void taskAndRecoveryEntryPointsKeepTheActorWhileRecheckingExistingWork() {
        var f = new Fixture();
        var records = new com.alibaba.qwen.code.managedagent.persistence.JdbcManagedExtensionRecordStore(f.jdbc);
        var events = new com.alibaba.qwen.code.managedagent.persistence.JdbcManagedTaskEventStore(f.jdbc);
        var tasks = new ManagedTaskService(f.service, records, events);
        var recovery = new SessionRecoveryService(f.service, f.store, f.coordinator, f.harness,
                new com.alibaba.qwen.code.managedagent.persistence.JdbcSessionRecoveryRepository(f.jdbc),
                new com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionStore(f.jdbc));
        f.tx.executeWithoutResult(status -> {
            String id = f.create(OWNER, "create");
            var foreign = SessionPrincipal.of("tenant", "user", "actor-B");
            assertThat(tasks.listPublicTasks(OWNER, id, null, 10).data()).isEmpty();
            assertThat(tasks.queryWebShellTasks(OWNER, id, null, 10).data()).isEmpty();
            denied(() -> tasks.listPublicTasks(foreign, id, null, 10));
            denied(() -> tasks.getPublicTask(foreign, id, "task_missing"));
            denied(() -> tasks.listPublicTaskEvents(foreign, id, "task_missing", null, 10));
            denied(() -> recovery.query(foreign, id));
            assertThat(recovery.query(OWNER, id).state()).isEqualTo("ready");
            var turn = f.service.submitTurn(OWNER, "turn", id,
                    List.of(new com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock("text", "recover")));
            f.jdbc.update("UPDATE ma_turn SET error_code=? WHERE tenant_id=? AND session_id=? AND turn_id=?",
                    AgentStateStore.RUNTIME_RECOVERY_BLOCKED, "tenant", id, turn.turnId());
            when(f.coordinator.recheckRecovery("tenant", id, turn.turnId())).thenReturn(true);
            assertThat(recovery.recheck(OWNER, id, turn.turnId())).isNotNull();
            denied(() -> recovery.recheck(foreign, id, turn.turnId()));
            org.mockito.Mockito.verify(f.coordinator).recheckRecovery("tenant", id, turn.turnId());
        });
    }

    @Test
    void principalAwareApiOverloadsNeverDowngradeToTheActorlessUser() {
        var f = new Fixture();
        var records =
                new com.alibaba.qwen.code.managedagent.persistence.JdbcManagedExtensionRecordStore(
                        f.jdbc);
        var hook =
                new com.alibaba.qwen.code.managedagent.catalog.ManagedHookCatalogService(
                        f.service, records);
        var mcp =
                new com.alibaba.qwen.code.managedagent.catalog.ManagedMcpCatalogService(
                        f.service, records);
        var mcpManagement =
                new com.alibaba.qwen.code.managedagent.catalog.ManagedMcpManagementService(
                        f.service, f.store, f.harness, new ObjectMapper());
        var skills =
                new com.alibaba.qwen.code.managedagent.catalog.ManagedSkillCatalogService(
                        f.service, mock(
                                com.alibaba.qwen.code.managedagent.persistence.JdbcManagedSessionSkills.class));
        var extensions =
                new com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionManagementService(
                        f.store, f.service, records,
                        mock(com.alibaba.qwen.code.managedagent.extensions.ManagedExtensionPackageService.class),
                        new ObjectMapper(), f.harness);
        var actionStore =
                new com.alibaba.qwen.code.managedagent.persistence.JdbcManagedActionStore(
                        f.jdbc, f.store);
        var actions =
                new com.alibaba.qwen.code.managedagent.session.ManagedActionService(
                        f.service, actionStore,
                        records, mock(ActionResponseCoordinator.class),
                        new RequestDigests(), Clock.systemUTC(), new ObjectMapper());
        f.tx.executeWithoutResult(status -> {
            String id = f.create(OWNER, "create");
            var sibling = SessionPrincipal.of("tenant", "user", "actor-B");

            assertThat(hook.get(OWNER, id).path("catalogs")).isEmpty();
            assertThat(mcp.get(OWNER, id).path("servers")).isEmpty();
            assertThat(skills.get(OWNER, id).skills()).isEmpty();
            assertThat(extensions.query(OWNER, id, null).path("supported")
                    .asBoolean()).isFalse();
            assertThat(actions.listPublic(OWNER, id, null, 10).data()).isEmpty();
            assertThat(mcpManagement.get(OWNER, id).path("supported")
                    .asBoolean()).isFalse();

            denied(() -> hook.get(sibling, id));
            denied(() -> mcp.get(sibling, id));
            denied(() -> skills.get(sibling, id));
            denied(() -> extensions.query(sibling, id, null));
            denied(() -> actions.listPublic(sibling, id, null, 10));
            denied(() -> mcpManagement.get(sibling, id));
            // R13-4: the action-response path keys on the same identity as
            // the read above, so the sibling never reaches the store's
            // admission (which would answer action_not_found for a missing
            // Action) and is refused exactly as the read refuses it.
            denied(() -> actions.respond("tenant", sibling, id, "tool_approval_missing",
                    "sibling-response", "permission",
                    com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.numberNode(1L),
                    "policy", "allow", null, false));
            denied(() -> f.service.requireReadableSession(sibling, id));
            assertThat(f.service.requireReadableSession(OWNER, id).sessionId())
                    .isEqualTo(id);
            // R13-4: the admission comparison keys on the ownership row too,
            // so a caller that reaches it without the read gate still cannot
            // re-admit the owner's Action decision under the shared user id.
            assertThatThrownBy(() -> actionStore.admit("tenant", id, sibling,
                    "user", "actor-digest", "sibling-admit", "c".repeat(64),
                    "tool_approval_missing",
                    com.fasterxml.jackson.databind.node.JsonNodeFactory
                            .instance.objectNode().put("optionId", "allow"), 1L))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode())
                                    .isEqualTo("action_forbidden"));
        });
    }

    @Test
    void ownerPaginationFiltersForeignActorsBeforeApplyingTheLimit() {
        var f = new Fixture();
        f.tx.executeWithoutResult(status -> {
            var expected = new java.util.HashSet<String>();
            for (int i = 0; i < 5; i++) {
                expected.add(f.create(OWNER, "own-" + i));
                f.create(SessionPrincipal.of("tenant", "user", "actor-B"), "foreign-" + i);
                f.create(SessionPrincipal.ofUser("tenant", "user"), "absent-" + i);
            }
            var found = new java.util.ArrayList<String>();
            String cursor = null;
            for (int page = 0; page < 5; page++) {
                var result = f.service.listPublicSessions(OWNER, cursor, 2, null, null);
                result.data().forEach(session -> found.add(session.id()));
                if (!result.hasMore()) {
                    break;
                }
                cursor = result.nextCursor();
            }
            assertThat(found).hasSize(5).doesNotHaveDuplicates().containsExactlyInAnyOrderElementsOf(expected);
        });
    }

    @Test
    void racingPrincipalsNeverReceiveEachOthersCreationAdmission() throws Exception {
        var f = new Fixture();
        var executor = java.util.concurrent.Executors.newFixedThreadPool(2);
        var start = new java.util.concurrent.CountDownLatch(1);
        try {
            var principals = List.of(OWNER, SessionPrincipal.of("tenant", "user", "actor-B"));
            var results = new java.util.ArrayList<java.util.concurrent.Future<Object>>();
            for (var principal : principals) {
                results.add(executor.submit(() -> {
                    assertThat(start.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                    try {
                        return f.tx.execute(status -> f.service.createSession(principal, "race", "qwen-code", null,
                                "private", Map.of(), List.of()));
                    } catch (ManagedAgentException denied) {
                        return denied;
                    }
                }));
            }
            start.countDown();
            int admitted = 0;
            int refused = 0;
            for (int i = 0; i < results.size(); i++) {
                Object result = results.get(i).get(10, java.util.concurrent.TimeUnit.SECONDS);
                if (result instanceof com.alibaba.qwen.code.managedagent.model.ApiModels.CommandAdmission admission) {
                    admitted++;
                    assertThat(f.store.ownsSession("tenant", admission.sessionId(), principals.get(i))).isTrue();
                    assertThat(f.store.ownsSession("tenant", admission.sessionId(), principals.get(1 - i))).isFalse();
                } else {
                    assertThat(result).isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("session_not_found"));
                    refused++;
                }
            }
            assertThat(admitted).isEqualTo(1);
            assertThat(refused).isEqualTo(1);
            assertThat(f.count("ma_session")).isEqualTo(1);
            assertThat(f.count("ma_session_principal")).isEqualTo(1);
        } finally {
            executor.shutdownNow();
            assertThat(executor.awaitTermination(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    void actorOwnerCanManageAndReplayDeletedSessionButSiblingActorCannot() {
        var f = new Fixture();
        var lifecycle = new SessionLifecycleService(f.store, f.service, new RequestDigests(),
                mock(SessionLifecycleCoordinator.class));
        f.tx.executeWithoutResult(status -> {
            String id = f.create(OWNER, "create");
            var sibling = SessionPrincipal.of("tenant", "user", "actor-B");
            denied(() -> lifecycle.admitPublic(sibling, "delete", id,
                    com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind.DELETE));
            assertThat(f.count("ma_operation")).isZero();
            var operation = lifecycle.admitPublic(OWNER, "delete", id,
                    com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind.DELETE);
            assertThat(lifecycle.getPublicOperation(OWNER, id, operation.id())).isNotNull();
            denied(() -> lifecycle.getPublicOperation(sibling, id, operation.id()));
            f.jdbc.update("UPDATE ma_session SET status='DELETED', deleted_at=1 WHERE session_id=?", id);
            var replay = lifecycle.admitPublic(OWNER, "delete", id,
                    com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind.DELETE);
            assertThat(replay.replayed()).isTrue();
            assertThat(replay.id()).isEqualTo(operation.id());
            denied(() -> lifecycle.admitPublic(sibling, "delete", id,
                    com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind.DELETE));
            assertThat(f.count("ma_operation")).isEqualTo(1);
        });
    }

    @Test
    void preOwnershipDigestRowsStillReplayAfterTheDeploy() {
        // R7-4: a rolling deploy must not retire idempotency rows written
        // by the pre-ownership code. A subjectless caller keeps the
        // {actorId} digest, an anonymous caller the empty digest — the
        // exact values the old code stored. Only a genuine legacy Session
        // (no ownership row) admits these callers at all.
        var f = new Fixture();
        var digests = new RequestDigests();
        var lifecycle = new SessionLifecycleService(f.store, f.service, digests,
                mock(SessionLifecycleCoordinator.class));
        f.tx.executeWithoutResult(status -> {
            String subjectless = f.store.insertSessionCommand("tenant", (String) null,
                    "CREATE_SESSION", "legacy-create", "digest", "qwen-code",
                    null, "legacy", List.of(), "payload")
                    .sessionId();
            var preOwnership = lifecycle.admitPublic("tenant", "legacy-user",
                    "legacy-delete", subjectless,
                    com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind.DELETE);
            String stored = f.jdbc.queryForObject(
                    "SELECT actor_digest FROM ma_operation WHERE operation_id = ?",
                    String.class, preOwnership.id());
            assertThat(stored).isEqualTo(digests.digest(Map.of("actorId", "legacy-user")));
            var replay = lifecycle.admitPublic("tenant", "legacy-user",
                    "legacy-delete", subjectless,
                    com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind.DELETE);
            assertThat(replay.replayed()).isTrue();
            assertThat(replay.id()).isEqualTo(preOwnership.id());
            // The anonymous arm keeps the empty digest the old code stored.
            String anonymousSession = f.store.insertSessionCommand("tenant", (String) null,
                    "CREATE_SESSION", "anonymous-create", "digest", "qwen-code",
                    null, "anonymous", List.of(), "payload")
                    .sessionId();
            var anonymous = lifecycle.admitPublic("tenant", null,
                    "anonymous-delete", anonymousSession,
                    com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind.DELETE);
            assertThat(f.jdbc.queryForObject(
                    "SELECT actor_digest FROM ma_operation WHERE operation_id = ?",
                    String.class, anonymous.id())).isEmpty();
            var anonymousReplay = lifecycle.admitPublic("tenant", null,
                    "anonymous-delete", anonymousSession,
                    com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind.DELETE);
            assertThat(anonymousReplay.replayed()).isTrue();
            assertThat(anonymousReplay.id()).isEqualTo(anonymous.id());
        });
    }

    @Test
    void rawLifecycleAndRenameServeAnActorThePrincipalByteBoundWouldReject() {
        // R11-2/R11-3: a filter-admitted 1536-byte actor keeps closing and
        // renaming a genuine legacy row-less Session; the raw arms never
        // construct a byte-bounded principal, and the stored operation
        // digest stays the pre-ownership {actorId} shape.
        String longActor = "界".repeat(512);
        var f = new Fixture();
        var digests = new RequestDigests();
        var lifecycle = new SessionLifecycleService(f.store, f.service, digests,
                mock(SessionLifecycleCoordinator.class));
        f.tx.executeWithoutResult(status -> {
            String id = f.store.insertSessionCommand("tenant", (String) null,
                    "CREATE_SESSION", "long-create", "digest", "qwen-code",
                    null, "legacy", List.of(), "payload").sessionId();
            when(f.harness.supportsFencedTitles()).thenReturn(true);
            when(f.harness.createOrLoad("tenant", id, false, true))
                    .thenReturn(new HarnessConnector.Attachment("boot", null, 0L, "epoch"));
            assertThat(f.service.renameSession("tenant", longActor,
                    "long-rename", id, "renamed").replayed()).isFalse();
            var operation = lifecycle.admitPublic("tenant", longActor,
                    "long-delete", id,
                    com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind.DELETE);
            assertThat(f.jdbc.queryForObject(
                    "SELECT actor_digest FROM ma_operation WHERE operation_id = ?",
                    String.class, operation.id()))
                    .isEqualTo(digests.digest(Map.of("actorId", longActor)));
        });
    }

    @Test
    void actorStreamDeliversStoredEventsAndRechecksTheSamePrincipal() throws Exception {
        var f = new Fixture();
        String id = f.tx.execute(status -> f.create(OWNER, "create"));
        var executor = java.util.concurrent.Executors.newSingleThreadExecutor();
        var properties = new ManagedAgentProperties();
        properties.getEvents().setPollInterval(java.time.Duration.ofMillis(10));
        properties.getEvents().setReadGrantRecheckInterval(java.time.Duration.ZERO);
        var delivered = new java.util.concurrent.LinkedBlockingQueue<Object>();
        var completed = new java.util.concurrent.CountDownLatch(1);
        var errors = new java.util.concurrent.LinkedBlockingQueue<Throwable>();
        var stream = new ManagedEventStreamService(f.service, new SessionEventHub(), executor, properties) {
            @Override
            org.springframework.web.servlet.mvc.method.annotation.SseEmitter emitter() {
                return new org.springframework.web.servlet.mvc.method.annotation.SseEmitter() {
                    @Override
                    public void send(SseEventBuilder event) {
                        event.build().forEach(part -> delivered.add(part.getData()));
                    }
                    @Override
                    public void complete() { completed.countDown(); }
                    @Override
                    public void completeWithError(Throwable error) {
                        errors.add(error);
                        completed.countDown();
                    }
                };
            }
        };
        try {
            denied(() -> stream.publicStream(SessionPrincipal.of("tenant", "user", "actor-B"), id, 0));
            denied(() -> stream.publicStream(SessionPrincipal.ofUser("tenant", "user"), id, 0));
            stream.publicStream(OWNER, id, 0);
            Object received = null;
            for (int attempt = 0; attempt < 10; attempt++) {
                Object next = delivered.poll(1, java.util.concurrent.TimeUnit.SECONDS);
                if (next instanceof com.alibaba.qwen.code.managedagent.model.ApiModels.PublicEvent) {
                    received = next;
                    break;
                }
            }
            assertThat(received).isInstanceOf(com.alibaba.qwen.code.managedagent.model.ApiModels.PublicEvent.class);
            assertThat(((com.alibaba.qwen.code.managedagent.model.ApiModels.PublicEvent) received).type())
                    .isEqualTo("session.created");
            f.jdbc.update("DELETE FROM ma_session_principal WHERE session_id=?", id);
            assertThat(completed.await(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
            assertThat(errors).isEmpty();
        } finally {
            executor.shutdownNow();
            assertThat(executor.awaitTermination(2, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        }
    }

    // R17-1: a read that abandons its authority check must not leave the
    // ownership row where a later decision on the same thread can consume it.
    // The decision re-reads the row, so a revoked Session answers 404 even
    // when the previous read saw the row.
    @Test
    void anAbandonedReadCannotAuthorizeAfterTheOwnershipRowIsRevoked() {
        var f = new Fixture();
        f.tx.executeWithoutResult(status -> {
            String revoked = f.create(OWNER, "create");
            assertThat(f.store.findSession("tenant", revoked)).isPresent();
            f.jdbc.update("DELETE FROM ma_session_principal WHERE tenant_id=?"
                    + " AND session_id=?", "tenant", revoked);
            denied(() -> ManagedSessionPrincipal.requireReadAuthority(
                    f.jdbc, "tenant", revoked, OWNER));
            // A normal read followed by its authorization still succeeds: the
            // fix must not turn a live Session into a false 404.
            String live = f.create(OWNER, "create-2");
            assertThat(f.store.findSession("tenant", live)).isPresent();
            ManagedSessionPrincipal.requireReadAuthority(f.jdbc, "tenant", live, OWNER);
        });
    }

    private static void denied(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(ManagedAgentException.class,
                error -> assertThat(error.getCode()).isEqualTo("session_not_found"));
    }

    private static final class Fixture {
        final JdbcTemplate jdbc;
        final ManagedAgentStore store;
        final ManagedAgentService service;
        final TransactionTemplate tx;
        final HarnessConnector harness;
        final HarnessCoordinator coordinator;
        final JdbcManagedWorkspaceRegistry workspaces;

        Fixture() {
            var source = new JdbcDataSource();
            source.setURL("jdbc:h2:mem:principal-" + UUID.randomUUID()
                    + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
            ManagedSchema.initialize(source);
            jdbc = new ManagedSchemaJdbcTemplate(source);
            workspaces = new JdbcManagedWorkspaceRegistry(jdbc);
            store = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(),
                    ignored -> {}, workspaces, new ManagedAgentProperties(),
                    new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
            harness = mock(HarnessConnector.class);
            when(harness.isAvailable()).thenReturn(true);
            coordinator = mock(HarnessCoordinator.class);
            service = new ManagedAgentService(store, new RequestDigests(), coordinator,
                    harness, workspaces,
                    new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
            tx = new TransactionTemplate(new DataSourceTransactionManager(source));
        }

        String create(SessionPrincipal principal, String key) {
            return service.createSession(principal, key, "qwen-code", null,
                    "private", Map.of(), List.of()).sessionId();
        }

        long count(String table) {
            return jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Long.class);
        }
    }
}
