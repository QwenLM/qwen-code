"""Outbound-only GitHub Release trigger for a single-node benchmark POC."""

from __future__ import annotations

import argparse
import logging
from typing import Any

import httpx

from .config import Settings, load_suites
from .models import RunRequest
from .store import Store


LOGGER = logging.getLogger(__name__)
GITHUB_API = "https://api.github.com"


class ReleasePoller:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        *,
        client: httpx.Client | None = None,
    ) -> None:
        self.settings = settings
        self.store = store
        self.client = client or httpx.Client(timeout=30)

    def poll_once(self) -> dict[str, Any] | None:
        """Queue the latest stable Release once, using its immutable release ID.

        Selecting only the newest stable release deliberately avoids backfilling a
        repository's historical releases when this timer is first enabled.
        """
        if not self.settings.github_token:
            raise RuntimeError("BENCHMARK_GITHUB_TOKEN is required for release polling")
        suites = load_suites()
        suite = suites.get(self.settings.release_poll_suite)
        if not suite:
            raise RuntimeError(
                f"release poll suite is not allowlisted: {self.settings.release_poll_suite}"
            )
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.settings.github_token}",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        releases = self.client.get(
            f"{GITHUB_API}/repos/{self.settings.allowed_repository}/releases",
            headers=headers,
            params={"per_page": 20},
        )
        releases.raise_for_status()
        stable = [
            release
            for release in releases.json()
            if not release.get("draft") and not release.get("prerelease")
        ]
        if not stable:
            LOGGER.info("no published stable release found")
            return None
        release = max(stable, key=lambda item: item.get("published_at") or "")
        tag = release["tag_name"]
        commit = self.client.get(
            f"{GITHUB_API}/repos/{self.settings.allowed_repository}/commits/{tag}",
            headers=headers,
        )
        commit.raise_for_status()
        request = RunRequest(
            repository=self.settings.allowed_repository,
            qwen_ref=tag,
            qwen_commit=commit.json()["sha"],
            suite=self.settings.release_poll_suite,
            trigger="release",
            release_id=int(release["id"]),
        )
        row, deduplicated = self.store.create_run(
            request,
            suite,
            f"github-release:{release['id']}:{self.settings.release_poll_suite}",
        )
        LOGGER.info(
            "%s benchmark run %s for release %s",
            "reused" if deduplicated else "queued",
            row["run_id"],
            tag,
        )
        return {"run_id": row["run_id"], "tag": tag, "deduplicated": deduplicated}


def main() -> None:
    parser = argparse.ArgumentParser(description="Queue latest Qwen Code stable release")
    parser.add_argument("--once", action="store_true", help="required for systemd timer use")
    args = parser.parse_args()
    if not args.once:
        parser.error("only --once is supported; schedule it with systemd")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = Settings.from_env()
    settings.prepare_directories()
    store = Store(settings.database_path)
    store.initialize()
    ReleasePoller(settings, store).poll_once()

