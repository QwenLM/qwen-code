# Copyright 2026 Qwen Team
# SPDX-License-Identifier: Apache-2.0

import importlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


class ReleaseBenchmarkServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        (root / "suites.json").write_text(
            json.dumps(
                {
                    "release-full-v1": {
                        "n_concurrent_trials": 1,
                        "datasets": [],
                    }
                }
            )
        )
        os.environ.update(
            {
                "BENCHMARK_ROOT": str(root),
                "PUBLIC_BASE_URL": "https://eval.example.com",
                "VIEWER_BASE_URL": "https://harbor.example.com",
                "OPENAI_MODEL": "qwen-test",
                "PYPI_INDEX_URL": "https://pypi.example.com/simple/",
                "GITHUB_RELEASE_CACHE_DIR": str(root / "cache" / "github"),
            }
        )
        Path(os.environ["GITHUB_RELEASE_CACHE_DIR"]).mkdir(parents=True)
        cls.app = importlib.import_module("app")
        cls.app.initialize()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        with self.app.connect() as connection:
            connection.execute("DELETE FROM jobs")

    def payload(self, event_name="release"):
        tag = "v0.19.11"
        workflow_ref = (
            "QwenLM/qwen-code/.github/workflows/"
            f"release-benchmark.yml@refs/tags/{tag}"
        )
        if event_name == "workflow_dispatch":
            workflow_ref = (
                "QwenLM/qwen-code/.github/workflows/"
                "release-benchmark.yml@refs/heads/main"
            )
        return self.app.BenchmarkRequest.model_validate(
            {
                "schema_version": 1,
                "idempotency_key": f"QwenLM/qwen-code:{tag}:release-full-v1",
                "release": {
                    "repository": "QwenLM/qwen-code",
                    "tag": tag,
                    "version": "0.19.11",
                    "url": f"https://github.com/QwenLM/qwen-code/releases/tag/{tag}",
                    "commit_sha": "a" * 40,
                },
                "suite": "release-full-v1",
                "trigger": {
                    "event_name": event_name,
                    "actor": "maintainer",
                    "run_id": "123",
                    "run_attempt": "1",
                    "workflow_ref": workflow_ref,
                },
                "callback": {
                    "repository": "QwenLM/qwen-code",
                    "commit_sha": "a" * 40,
                    "actions_run_url": (
                        "https://github.com/QwenLM/qwen-code/actions/runs/123"
                    ),
                },
            }
        )

    def claims(self, payload):
        ref = (
            f"refs/tags/{payload.release.tag}"
            if payload.trigger.event_name == "release"
            else "refs/heads/main"
        )
        return {
            "sub": "repo:QwenLM/qwen-code:environment:release-benchmark",
            "repository": "QwenLM/qwen-code",
            "repository_id": "1008713177",
            "repository_owner_id": "141221163",
            "event_name": payload.trigger.event_name,
            "actor": payload.trigger.actor,
            "run_id": payload.trigger.run_id,
            "run_attempt": payload.trigger.run_attempt,
            "workflow_ref": payload.trigger.workflow_ref,
            "ref": ref,
        }

    def test_accepts_release_and_main_dispatch_claims(self):
        for event_name in ("release", "workflow_dispatch"):
            payload = self.payload(event_name)
            self.app.validate_claims(self.claims(payload), payload)

    def test_rejects_wrong_ref(self):
        payload = self.payload()
        claims = self.claims(payload)
        claims["ref"] = "refs/heads/main"
        with self.assertRaises(self.app.HTTPException) as raised:
            self.app.validate_claims(claims, payload)
        self.assertEqual(raised.exception.status_code, 403)

    def test_rejects_wrong_run_identity(self):
        payload = self.payload()
        for claim in ("run_id", "run_attempt"):
            claims = self.claims(payload)
            claims[claim] = "999"
            with self.assertRaises(self.app.HTTPException) as raised:
                self.app.validate_claims(claims, payload)
            self.assertEqual(raised.exception.status_code, 403)

    def test_enqueue_is_idempotent(self):
        payload = self.payload()
        job_id, created = self.app.enqueue(payload)
        repeated_job_id, repeated_created = self.app.enqueue(payload)
        self.assertTrue(created)
        self.assertFalse(repeated_created)
        self.assertEqual(job_id, repeated_job_id)

    def test_job_page_links_direct_harbor_report(self):
        payload = self.payload()
        job_id, _ = self.app.enqueue(payload)
        response = self.app.job_page(job_id)
        expected = (
            b"https://harbor.example.com/jobs/v0.19.11-release-full-v1"
        )
        self.assertIn(expected, response.body)

    def test_run_job_passes_package_index_to_container(self):
        payload = self.payload()
        job_id, _ = self.app.enqueue(payload)
        with self.app.connect() as connection:
            job = connection.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
        with mock.patch.object(
            self.app.subprocess, "run", return_value=mock.Mock(returncode=0)
        ):
            self.app.run_job(job)
        config_path = self.app.CONFIG_DIR / f"{job_id}.json"
        config = json.loads(config_path.read_text())
        self.assertEqual(
            config["agents"][0]["import_path"],
            "qwen_coder_mirror:QwenCoderMirror",
        )
        self.assertEqual(
            config["environment"]["env"],
            {
                "PIP_INDEX_URL": "https://pypi.example.com/simple/",
                "UV_INDEX_URL": "https://pypi.example.com/simple/",
                "UV_INSTALLER_GITHUB_BASE_URL": "file:///opt/github",
                "UV_PYTHON_INSTALL_MIRROR": (
                    "https://releases.astral.sh/github/"
                    "python-build-standalone/releases/download"
                ),
            },
        )
        self.assertEqual(
            config["environment"]["mounts"],
            [
                {
                    "type": "bind",
                    "source": os.environ["GITHUB_RELEASE_CACHE_DIR"],
                    "target": "/opt/github",
                    "read_only": True,
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
