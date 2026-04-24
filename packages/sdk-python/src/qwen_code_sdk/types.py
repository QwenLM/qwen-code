"""Public type definitions for qwen_code_sdk."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, MutableMapping
from dataclasses import dataclass
from inspect import Parameter, Signature, iscoroutinefunction, signature
from typing import (
    Any,
    Literal,
    TypeAlias,
    TypedDict,
    cast,
)

from typing_extensions import NotRequired

PermissionMode: TypeAlias = Literal["default", "plan", "auto-edit", "yolo"]
AuthType: TypeAlias = Literal[
    "openai",
    "anthropic",
    "qwen-oauth",
    "gemini",
    "vertex-ai",
]


class PermissionSuggestion(TypedDict):
    type: Literal["allow", "deny", "modify"]
    label: str
    description: NotRequired[str]
    modifiedInput: NotRequired[Any]


class PermissionAllowResult(TypedDict):
    behavior: Literal["allow"]
    updatedInput: NotRequired[dict[str, Any]]


class PermissionDenyResult(TypedDict):
    behavior: Literal["deny"]
    message: NotRequired[str]
    interrupt: NotRequired[bool]


PermissionResult: TypeAlias = PermissionAllowResult | PermissionDenyResult


class CanUseToolContext(TypedDict):
    cancel_event: Any
    suggestions: list[PermissionSuggestion] | None
    blocked_path: str | None


CanUseTool: TypeAlias = Callable[
    [str, dict[str, Any], CanUseToolContext],
    Awaitable[PermissionResult],
]


class TimeoutOptionsDict(TypedDict, total=False):
    """Timeout configuration. All values are in seconds."""

    can_use_tool: float
    control_request: float
    stream_close: float


@dataclass(frozen=True)
class TimeoutOptions:
    can_use_tool: float = 60.0
    control_request: float = 60.0
    stream_close: float = 60.0

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any] | None) -> TimeoutOptions:
        if value is None:
            return cls()

        def _read(name: str, default: float) -> float:
            raw = value.get(name, default)
            if isinstance(raw, bool) or not isinstance(raw, (int, float)):
                raise TypeError(f"timeout.{name} must be a positive number")
            if raw <= 0:
                raise ValueError(f"timeout.{name} must be a positive number")
            return float(raw)

        return cls(
            can_use_tool=_read("can_use_tool", 60.0),
            control_request=_read("control_request", 60.0),
            stream_close=_read("stream_close", 60.0),
        )


class QueryOptionsDict(TypedDict, total=False):
    cwd: str
    model: str
    path_to_qwen_executable: str
    permission_mode: PermissionMode
    can_use_tool: CanUseTool
    env: dict[str, str]
    system_prompt: str
    append_system_prompt: str
    debug: bool
    max_session_turns: int
    core_tools: list[str]
    exclude_tools: list[str]
    allowed_tools: list[str]
    auth_type: AuthType
    include_partial_messages: bool
    resume: str
    continue_session: bool
    session_id: str
    timeout: TimeoutOptionsDict
    mcp_servers: dict[str, dict[str, Any]]
    stderr: Callable[[str], None]


@dataclass
class QueryOptions:
    cwd: str | None = None
    model: str | None = None
    path_to_qwen_executable: str | None = None
    permission_mode: PermissionMode | None = None
    can_use_tool: CanUseTool | None = None
    env: dict[str, str] | None = None
    system_prompt: str | None = None
    append_system_prompt: str | None = None
    debug: bool = False
    max_session_turns: int | None = None
    core_tools: list[str] | None = None
    exclude_tools: list[str] | None = None
    allowed_tools: list[str] | None = None
    auth_type: AuthType | None = None
    include_partial_messages: bool = False
    resume: str | None = None
    continue_session: bool = False
    session_id: str | None = None
    timeout: TimeoutOptions = TimeoutOptions()
    mcp_servers: dict[str, dict[str, Any]] | None = None
    stderr: Callable[[str], None] | None = None

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any] | None) -> QueryOptions:
        if value is None:
            return cls()

        data: MutableMapping[str, Any] = dict(value)
        timeout = TimeoutOptions.from_mapping(data.get("timeout"))

        return cls(
            cwd=_as_optional_str(data, "cwd"),
            model=_as_optional_str(data, "model"),
            path_to_qwen_executable=_as_optional_str(data, "path_to_qwen_executable"),
            permission_mode=cast(
                PermissionMode | None,
                _as_optional_str(data, "permission_mode"),
            ),
            can_use_tool=cast(
                CanUseTool | None,
                _as_optional_callable(data, "can_use_tool"),
            ),
            env=_as_optional_str_dict(data, "env"),
            system_prompt=_as_optional_str(data, "system_prompt"),
            append_system_prompt=_as_optional_str(data, "append_system_prompt"),
            debug=_as_optional_bool(data, "debug") or False,
            max_session_turns=_as_optional_int(data, "max_session_turns"),
            core_tools=_as_optional_str_list(data, "core_tools"),
            exclude_tools=_as_optional_str_list(data, "exclude_tools"),
            allowed_tools=_as_optional_str_list(data, "allowed_tools"),
            auth_type=cast(
                AuthType | None,
                _as_optional_str(data, "auth_type"),
            ),
            include_partial_messages=_as_optional_bool(data, "include_partial_messages")
            or False,
            resume=_as_optional_str(data, "resume"),
            continue_session=_as_optional_bool(data, "continue_session") or False,
            session_id=_as_optional_str(data, "session_id"),
            timeout=timeout,
            mcp_servers=_as_optional_nested_dict(data, "mcp_servers"),
            stderr=cast(
                Callable[[str], None] | None,
                _as_optional_callable(data, "stderr"),
            ),
        )


def _as_optional_str(data: Mapping[str, Any], key: str) -> str | None:
    raw = data.get(key)
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise TypeError(f"{key} must be a string")
    return raw


def _as_optional_int(data: Mapping[str, Any], key: str) -> int | None:
    raw = data.get(key)
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise TypeError(f"{key} must be an integer")
    return int(raw)


def _as_optional_bool(data: Mapping[str, Any], key: str) -> bool | None:
    raw = data.get(key)
    if raw is None:
        return None
    if not isinstance(raw, bool):
        raise TypeError(f"{key} must be a boolean")
    return raw


def _as_optional_callable(
    data: Mapping[str, Any], key: str
) -> Callable[..., Any] | None:
    raw = data.get(key)
    if raw is None:
        return None
    if not callable(raw):
        raise TypeError(f"{key} must be callable")
    if key == "can_use_tool":
        _validate_can_use_tool_callable(raw, error_type=TypeError)
    elif key == "stderr":
        _validate_stderr_callable(raw, error_type=TypeError)
    return cast(Callable[..., Any], raw)


def _validate_can_use_tool_callable(value: object, error_type: type[Exception]) -> None:
    if not callable(value):
        raise error_type("can_use_tool must be callable")

    if not iscoroutinefunction(value):
        raise error_type("can_use_tool must be an async callable")

    try:
        sig = signature(value)
    except (TypeError, ValueError):
        return

    if not _supports_argument_count(sig, 3):
        raise error_type("can_use_tool must accept exactly 3 positional arguments")


def _validate_stderr_callable(value: object, error_type: type[Exception]) -> None:
    if not callable(value):
        raise error_type("stderr must be callable")

    try:
        sig = signature(value)
    except (TypeError, ValueError):
        return

    if not _supports_argument_count(sig, 1):
        raise error_type("stderr must accept exactly 1 positional argument")


def _supports_argument_count(sig: Signature, count: int) -> bool:
    params = list(sig.parameters.values())
    positional_params = [
        param
        for param in params
        if param.kind
        in (
            Parameter.POSITIONAL_ONLY,
            Parameter.POSITIONAL_OR_KEYWORD,
        )
    ]
    required_positional = [
        param for param in positional_params if param.default is Parameter.empty
    ]
    has_var_positional = any(param.kind is Parameter.VAR_POSITIONAL for param in params)

    if len(required_positional) > count:
        return False
    if has_var_positional:
        return True
    return len(positional_params) >= count


def _as_optional_str_dict(data: Mapping[str, Any], key: str) -> dict[str, str] | None:
    raw = data.get(key)
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise TypeError(f"{key} must be a mapping of string to string")

    parsed: dict[str, str] = {}
    for k, v in raw.items():
        if not isinstance(k, str) or not isinstance(v, str):
            raise TypeError(f"{key} must be a mapping of string to string")
        parsed[k] = v
    return parsed


def _as_optional_str_list(data: Mapping[str, Any], key: str) -> list[str] | None:
    raw = data.get(key)
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise TypeError(f"{key} must be a list of strings")
    if any(not isinstance(item, str) for item in raw):
        raise TypeError(f"{key} must be a list of strings")
    return list(raw)


def _as_optional_nested_dict(
    data: Mapping[str, Any], key: str
) -> dict[str, dict[str, Any]] | None:
    raw = data.get(key)
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise TypeError(f"{key} must be a mapping")

    parsed: dict[str, dict[str, Any]] = {}
    for k, v in raw.items():
        if not isinstance(k, str) or not isinstance(v, Mapping):
            raise TypeError(f"{key} must be a mapping of string to mapping")
        parsed[k] = dict(v)
    return parsed
