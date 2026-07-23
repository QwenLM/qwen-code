from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    repository: Literal["QwenLM/qwen-code"] = "QwenLM/qwen-code"
    qwen_ref: str = Field(
        min_length=1,
        max_length=160,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._/@+-]*$",
    )
    qwen_commit: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{40}$")
    suite: str = Field(min_length=1, max_length=100)
    trigger: Literal["release", "workflow_dispatch", "manual"]
    release_id: int | None = None
    github_run_id: int | None = None
    github_run_attempt: int | None = None

    @field_validator("qwen_ref")
    @classmethod
    def reject_revision_syntax(cls, value: str) -> str:
        if ".." in value or "@{" in value:
            raise ValueError("qwen_ref contains unsupported revision syntax")
        return value
