from __future__ import annotations

import os

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, status

from .auth import authenticate
from .config import Settings, load_suites
from .models import RunDetail, RunRequest, RunResponse
from .store import Store


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.prepare_directories()
    store = Store(settings.database_path)
    store.initialize()
    suites = load_suites()

    app = FastAPI(title="Qwen Code Benchmark Service", version="0.1.0")
    app.state.settings = settings
    app.state.store = store
    app.state.suites = suites

    @app.get("/healthz")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    async def ready() -> dict[str, str]:
        with store.connect() as connection:
            connection.execute("SELECT 1").fetchone()
        return {"status": "ready"}

    @app.post(
        "/api/v1/runs",
        response_model=RunResponse,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_run(
        request: RunRequest,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        claims: dict = Depends(authenticate),
    ) -> RunResponse:
        if not 1 <= len(idempotency_key) <= 255:
            raise HTTPException(status_code=422, detail="invalid idempotency key")
        if claims.get("repository") != request.repository:
            raise HTTPException(status_code=403, detail="repository mismatch")
        suite = suites.get(request.suite)
        if not suite:
            raise HTTPException(status_code=422, detail="suite not allowed")
        row, deduplicated = store.create_run(request, suite, idempotency_key)
        return RunResponse(
            run_id=row["run_id"],
            status=row["status"],
            status_url=f"/api/v1/runs/{row['run_id']}",
            deduplicated=deduplicated,
        )

    @app.get(
        "/api/v1/runs/{run_id}",
        response_model=RunDetail,
        dependencies=[Depends(authenticate)],
    )
    async def get_run(run_id: str) -> RunDetail:
        row = store.get_run(run_id)
        if not row:
            raise HTTPException(status_code=404, detail="run not found")
        return RunDetail(**row)

    @app.post(
        "/api/v1/runs/{run_id}/cancel",
        dependencies=[Depends(authenticate)],
    )
    async def cancel_run(run_id: str) -> dict[str, str]:
        if not store.get_run(run_id):
            raise HTTPException(status_code=404, detail="run not found")
        if not store.cancel(run_id):
            raise HTTPException(status_code=409, detail="run cannot be canceled")
        return {"run_id": run_id, "status": "CANCELED"}

    @app.post(
        "/api/v1/runs/{run_id}/retry",
        dependencies=[Depends(authenticate)],
    )
    async def retry_run(run_id: str) -> dict[str, str]:
        if not store.get_run(run_id):
            raise HTTPException(status_code=404, detail="run not found")
        if not store.retry(run_id):
            raise HTTPException(status_code=409, detail="run cannot be retried")
        return {"run_id": run_id, "status": "QUEUED"}

    return app


def main() -> None:
    uvicorn.run(
        create_app(),
        host=os.environ.get("BENCHMARK_HOST", "127.0.0.1"),
        port=int(os.environ.get("BENCHMARK_PORT", "8000")),
        proxy_headers=True,
    )
