from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import Suite
from .models import RunRequest


TERMINAL_RUN_STATES = {"SUCCEEDED", "FAILED", "CANCELED"}


def now() -> str:
    return datetime.now(UTC).isoformat()


class Store:
    def __init__(self, database_path: Path):
        self.database_path = database_path

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def initialize(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    repository TEXT NOT NULL,
                    qwen_ref TEXT NOT NULL,
                    qwen_commit TEXT,
                    suite TEXT NOT NULL,
                    dataset TEXT NOT NULL,
                    dataset_revision TEXT NOT NULL,
                    runner_mode TEXT NOT NULL,
                    status TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    expected_instances INTEGER NOT NULL,
                    completed_instances INTEGER NOT NULL DEFAULT 0,
                    resolved_instances INTEGER NOT NULL DEFAULT 0,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    max_attempts INTEGER NOT NULL DEFAULT 2,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    heartbeat_at TEXT
                );

                CREATE TABLE IF NOT EXISTS instances (
                    run_id TEXT NOT NULL,
                    instance_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    error TEXT,
                    started_at TEXT,
                    finished_at TEXT,
                    PRIMARY KEY (run_id, instance_id),
                    FOREIGN KEY (run_id) REFERENCES runs(run_id)
                );

                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    detail_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (run_id) REFERENCES runs(run_id)
                );
                """
            )

    def create_run(
        self,
        request: RunRequest,
        suite: Suite,
        idempotency_key: str,
    ) -> tuple[dict[str, Any], bool]:
        created_at = now()
        run_id = f"qwen-bench-{uuid.uuid4().hex[:16]}"
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT * FROM runs WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
            if existing:
                return dict(existing), True

            connection.execute(
                """
                INSERT INTO runs (
                    run_id, idempotency_key, repository, qwen_ref, qwen_commit, suite,
                    dataset, dataset_revision, runner_mode, status,
                    request_json, expected_instances, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?)
                """,
                (
                    run_id,
                    idempotency_key,
                    request.repository,
                    request.qwen_ref,
                    request.qwen_commit,
                    request.suite,
                    suite["dataset"],
                    suite["dataset_revision"],
                    suite["runner_mode"],
                    request.model_dump_json(),
                    len(suite["instance_ids"]),
                    created_at,
                ),
            )
            connection.executemany(
                """
                INSERT INTO instances (run_id, instance_id, status)
                VALUES (?, ?, 'PENDING')
                """,
                [(run_id, instance_id) for instance_id in suite["instance_ids"]],
            )
            self._event(connection, run_id, "RUN_CREATED", request.model_dump())
            row = connection.execute(
                "SELECT * FROM runs WHERE run_id = ?", (run_id,)
            ).fetchone()
            return dict(row), False

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM runs WHERE run_id = ?", (run_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_instances(self, run_id: str) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM instances WHERE run_id = ? ORDER BY instance_id",
                (run_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    def claim_run(self) -> dict[str, Any] | None:
        claimed_at = now()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT * FROM runs
                WHERE status = 'QUEUED'
                ORDER BY created_at
                LIMIT 1
                """
            ).fetchone()
            if not row:
                return None
            updated = connection.execute(
                """
                UPDATE runs
                SET status = 'PREPARING', started_at = COALESCE(started_at, ?),
                    heartbeat_at = ?, attempt_count = attempt_count + 1,
                    error = NULL
                WHERE run_id = ? AND status = 'QUEUED'
                """,
                (claimed_at, claimed_at, row["run_id"]),
            )
            if updated.rowcount != 1:
                return None
            self._event(connection, row["run_id"], "RUN_CLAIMED", {})
            claimed = connection.execute(
                "SELECT * FROM runs WHERE run_id = ?", (row["run_id"],)
            ).fetchone()
            return dict(claimed)

    def transition(
        self,
        run_id: str,
        status: str,
        *,
        error: str | None = None,
        qwen_commit: str | None = None,
        completed_instances: int | None = None,
        resolved_instances: int | None = None,
    ) -> None:
        fields = ["status = ?", "heartbeat_at = ?", "error = ?"]
        values: list[Any] = [status, now(), error]
        if qwen_commit is not None:
            fields.append("qwen_commit = ?")
            values.append(qwen_commit)
        if completed_instances is not None:
            fields.append("completed_instances = ?")
            values.append(completed_instances)
        if resolved_instances is not None:
            fields.append("resolved_instances = ?")
            values.append(resolved_instances)
        if status in TERMINAL_RUN_STATES:
            fields.append("finished_at = ?")
            values.append(now())
        values.append(run_id)
        with self.connect() as connection:
            connection.execute(
                f"UPDATE runs SET {', '.join(fields)} WHERE run_id = ?",
                values,
            )
            self._event(connection, run_id, "RUN_STATUS", {"status": status})

    def heartbeat(self, run_id: str) -> None:
        with self.connect() as connection:
            connection.execute(
                "UPDATE runs SET heartbeat_at = ? WHERE run_id = ?",
                (now(), run_id),
            )

    def update_instance(
        self,
        run_id: str,
        instance_id: str,
        status: str,
        error: str | None = None,
    ) -> None:
        terminal = status in {
            "RESOLVED",
            "UNRESOLVED",
            "AGENT_FAILED",
            "INFRA_FAILED",
            "TIMEOUT",
            "CANCELED",
        }
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE instances
                SET status = ?, error = ?,
                    started_at = CASE
                        WHEN started_at IS NULL AND ? = 'RUNNING' THEN ?
                        ELSE started_at
                    END,
                    finished_at = CASE WHEN ? THEN ? ELSE finished_at END
                WHERE run_id = ? AND instance_id = ?
                """,
                (
                    status,
                    error,
                    status,
                    now(),
                    terminal,
                    now(),
                    run_id,
                    instance_id,
                ),
            )

    def requeue_or_fail(self, run_id: str, error: str) -> str:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT attempt_count, max_attempts FROM runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if row and row["attempt_count"] < row["max_attempts"]:
                status = "QUEUED"
                finished_at = None
            else:
                status = "FAILED"
                finished_at = now()
            connection.execute(
                """
                UPDATE runs
                SET status = ?, error = ?, heartbeat_at = ?, finished_at = ?
                WHERE run_id = ?
                """,
                (status, error, now(), finished_at, run_id),
            )
            self._event(
                connection,
                run_id,
                "INFRA_FAILURE",
                {"status": status, "error": error},
            )
            return status

    def cancel(self, run_id: str) -> bool:
        with self.connect() as connection:
            updated = connection.execute(
                """
                UPDATE runs SET status = 'CANCELED', finished_at = ?, heartbeat_at = ?
                WHERE run_id = ? AND status IN ('QUEUED', 'FAILED')
                """,
                (now(), now(), run_id),
            )
            return updated.rowcount == 1

    def retry(self, run_id: str) -> bool:
        with self.connect() as connection:
            updated = connection.execute(
                """
                UPDATE runs
                SET status = 'QUEUED', error = NULL, finished_at = NULL
                WHERE run_id = ? AND status = 'FAILED'
                """,
                (run_id,),
            )
            return updated.rowcount == 1

    @staticmethod
    def _event(
        connection: sqlite3.Connection,
        run_id: str,
        event_type: str,
        detail: dict[str, Any],
    ) -> None:
        connection.execute(
            """
            INSERT INTO events (run_id, event_type, detail_json, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (run_id, event_type, json.dumps(detail, sort_keys=True), now()),
        )
