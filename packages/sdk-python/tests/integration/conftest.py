from __future__ import annotations

import os
import stat
import textwrap
from pathlib import Path

import pytest


@pytest.fixture()
def fake_qwen_path(tmp_path: Path) -> str:
    script_path = tmp_path / "fake_qwen.py"
    script_path.write_text(
        textwrap.dedent(
            """
            #!/usr/bin/env python3
            import argparse
            import json
            import sys
            import uuid


            def send(message):
                sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\\n")
                sys.stdout.flush()


            def parse_user_content(message):
                payload = message.get("message", {})
                content = payload.get("content", "")
                if isinstance(content, str):
                    return content
                if isinstance(content, list):
                    text_parts = []
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text_parts.append(str(block.get("text", "")))
                    return " ".join(text_parts)
                return str(content)


            def build_system_message():
                return {
                    "type": "system",
                    "subtype": "init",
                    "uuid": session_id,
                    "session_id": session_id,
                    "cwd": ".",
                    "tools": ["Read", "Edit", "Bash"],
                    "mcp_servers": [],
                    "model": state["model"],
                    "permission_mode": state["permission_mode"],
                    "qwen_code_version": "fake-1.0.0",
                    "capabilities": {
                        "canSetModel": True,
                        "canSetPermissionMode": True,
                    },
                }


            def build_assistant_message(text):
                return {
                    "type": "assistant",
                    "uuid": str(uuid.uuid4()),
                    "session_id": session_id,
                    "message": {
                        "id": str(uuid.uuid4()),
                        "type": "message",
                        "role": "assistant",
                        "model": state["model"],
                        "content": [
                            {
                                "type": "text",
                                "text": text,
                            }
                        ],
                        "usage": {
                            "input_tokens": 1,
                            "output_tokens": 1,
                        },
                    },
                    "parent_tool_use_id": None,
                }


            def build_result_message(result_text):
                return {
                    "type": "result",
                    "subtype": "success",
                    "uuid": str(uuid.uuid4()),
                    "session_id": session_id,
                    "is_error": False,
                    "duration_ms": 5,
                    "duration_api_ms": 1,
                    "num_turns": 1,
                    "result": result_text,
                    "usage": {
                        "input_tokens": 1,
                        "output_tokens": 1,
                    },
                    "permission_denials": [],
                }


            parser = argparse.ArgumentParser(add_help=False)
            parser.add_argument("--model")
            parser.add_argument("--approval-mode")
            parser.add_argument("--include-partial-messages", action="store_true")
            parser.add_argument("--session-id")
            parser.add_argument("--resume")
            parser.add_argument(
                "--continue",
                dest="continue_session",
                action="store_true",
            )
            args, _ = parser.parse_known_args()

            session_id = (
                args.resume
                or args.session_id
                or (
                    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
                    if args.continue_session
                    else str(uuid.uuid4())
                )
            )
            state = {
                "model": args.model or "coder-model",
                "permission_mode": args.approval_mode or "default",
                "include_partial": bool(args.include_partial_messages),
            }

            pending_permission = None
            pending_unknown_control = None

            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                message = json.loads(line)
                msg_type = message.get("type")

                if msg_type == "control_request":
                    request_id = message["request_id"]
                    request = message["request"]
                    subtype = request.get("subtype")

                    if subtype == "initialize":
                        send(
                            {
                                "type": "control_response",
                                "response": {
                                    "subtype": "success",
                                    "request_id": request_id,
                                    "response": {},
                                },
                            }
                        )
                        send(build_system_message())
                    elif subtype == "set_model":
                        state["model"] = request["model"]
                        send(
                            {
                                "type": "control_response",
                                "response": {
                                    "subtype": "success",
                                    "request_id": request_id,
                                    "response": {},
                                },
                            }
                        )
                        send(build_system_message())
                    elif subtype == "set_permission_mode":
                        state["permission_mode"] = request["mode"]
                        send(
                            {
                                "type": "control_response",
                                "response": {
                                    "subtype": "success",
                                    "request_id": request_id,
                                    "response": {},
                                },
                            }
                        )
                        send(build_system_message())
                    elif subtype == "interrupt":
                        send(
                            {
                                "type": "control_response",
                                "response": {
                                    "subtype": "success",
                                    "request_id": request_id,
                                    "response": {},
                                },
                            }
                        )
                    elif subtype == "supported_commands":
                        send(
                            {
                                "type": "control_response",
                                "response": {
                                    "subtype": "success",
                                    "request_id": request_id,
                                    "response": {
                                        "commands": [
                                            "initialize",
                                            "interrupt",
                                            "set_model",
                                            "set_permission_mode",
                                        ]
                                    },
                                },
                            }
                        )
                    elif subtype == "mcp_server_status":
                        send(
                            {
                                "type": "control_response",
                                "response": {
                                    "subtype": "success",
                                    "request_id": request_id,
                                    "response": {"servers": []},
                                },
                            }
                        )
                    else:
                        send(
                            {
                                "type": "control_response",
                                "response": {
                                    "subtype": "error",
                                    "request_id": request_id,
                                    "error": f"unsupported request: {subtype}",
                                },
                            }
                        )

                elif msg_type == "user":
                    prompt = parse_user_content(message)

                    if "exit nonzero" in prompt:
                        sys.exit(9)

                    if "request unknown control" in prompt:
                        request_id = str(uuid.uuid4())
                        pending_unknown_control = {
                            "request_id": request_id,
                            "prompt": prompt,
                        }
                        send(
                            {
                                "type": "control_request",
                                "request_id": request_id,
                                "request": {
                                    "subtype": "something_new",
                                    "payload": {},
                                },
                            }
                        )
                        continue

                    if "use tool" in prompt or "create file" in prompt:
                        tool_use_id = str(uuid.uuid4())
                        send(
                            {
                                "type": "assistant",
                                "uuid": str(uuid.uuid4()),
                                "session_id": session_id,
                                "message": {
                                    "id": str(uuid.uuid4()),
                                    "type": "message",
                                    "role": "assistant",
                                    "model": state["model"],
                                    "content": [
                                        {
                                            "type": "tool_use",
                                            "id": tool_use_id,
                                            "name": "write_file",
                                            "input": {
                                                "path": "demo.txt",
                                                "content": "hello",
                                            },
                                        }
                                    ],
                                    "usage": {"input_tokens": 1, "output_tokens": 1},
                                },
                                "parent_tool_use_id": None,
                            }
                        )
                        request_id = str(uuid.uuid4())
                        pending_permission = {
                            "request_id": request_id,
                            "tool_use_id": tool_use_id,
                            "prompt": prompt,
                        }
                        send(
                            {
                                "type": "control_request",
                                "request_id": request_id,
                                "request": {
                                    "subtype": "can_use_tool",
                                    "tool_name": "write_file",
                                    "tool_use_id": tool_use_id,
                                    "input": {"path": "demo.txt", "content": "hello"},
                                    "permission_suggestions": [
                                        {"type": "allow", "label": "Allow write"}
                                    ],
                                    "blocked_path": None,
                                },
                            }
                        )
                        continue

                    if state["include_partial"]:
                        send(
                            {
                                "type": "stream_event",
                                "uuid": str(uuid.uuid4()),
                                "session_id": session_id,
                                "event": {
                                    "type": "content_block_delta",
                                    "index": 0,
                                    "delta": {"type": "text_delta", "text": "partial"},
                                },
                                "parent_tool_use_id": None,
                            }
                        )

                    send(build_assistant_message(f"Echo: {prompt}"))
                    send(build_result_message(f"done: {prompt}"))

                elif msg_type == "control_response":
                    payload = message.get("response", {})
                    request_id = payload.get("request_id")

                    if (
                        pending_unknown_control
                        and request_id == pending_unknown_control["request_id"]
                    ):
                        if payload.get("subtype") != "error":
                            sys.exit(3)
                        prompt = pending_unknown_control["prompt"]
                        pending_unknown_control = None
                        send(
                            build_assistant_message(
                                f"Unknown control handled for: {prompt}"
                            )
                        )
                        send(build_result_message(f"unknown-control: {prompt}"))
                        continue

                    if (
                        pending_permission
                        and request_id == pending_permission["request_id"]
                    ):
                        prompt = pending_permission["prompt"]
                        tool_use_id = pending_permission["tool_use_id"]
                        pending_permission = None

                        behavior = "deny"
                        if payload.get("subtype") == "success":
                            response_payload = payload.get("response") or {}
                            behavior = response_payload.get("behavior", "deny")

                        is_allowed = behavior == "allow"
                        send(
                            {
                                "type": "user",
                                "session_id": session_id,
                                "message": {
                                    "role": "user",
                                    "content": [
                                        {
                                            "type": "tool_result",
                                            "tool_use_id": tool_use_id,
                                            "is_error": not is_allowed,
                                            "content": "ok" if is_allowed else "denied",
                                        }
                                    ],
                                },
                                "parent_tool_use_id": tool_use_id,
                            }
                        )
                        send(build_assistant_message(f"tool handled: {prompt}"))
                        send(build_result_message(f"tool-result: {prompt}"))
                        continue
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )
    script_path.chmod(script_path.stat().st_mode | stat.S_IEXEC)
    return str(script_path)


@pytest.fixture(autouse=True)
def disable_history_expansion() -> None:
    # No-op fixture used as explicit marker for deterministic test env.
    os.environ.setdefault("PYTHONUTF8", "1")
