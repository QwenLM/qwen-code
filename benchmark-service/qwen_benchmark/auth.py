from __future__ import annotations

import hmac
from typing import Any

import jwt
from fastapi import Header, HTTPException, Request

from .config import Settings


GITHUB_ISSUER = "https://token.actions.githubusercontent.com"
GITHUB_JWKS_URL = f"{GITHUB_ISSUER}/.well-known/jwks"
_jwks_client = jwt.PyJWKClient(GITHUB_JWKS_URL)


async def authenticate(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    settings: Settings = request.app.state.settings
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization.removeprefix("Bearer ")

    if settings.auth_mode == "token":
        if not settings.shared_token:
            raise HTTPException(status_code=503, detail="shared token not configured")
        if not hmac.compare_digest(token, settings.shared_token):
            raise HTTPException(status_code=401, detail="invalid bearer token")
        return {"repository": settings.allowed_repository, "auth": "token"}

    try:
        signing_key = _jwks_client.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=settings.oidc_audience,
            issuer=GITHUB_ISSUER,
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
        )
    except jwt.PyJWTError as error:
        raise HTTPException(status_code=401, detail="invalid OIDC token") from error

    if claims.get("repository") != settings.allowed_repository:
        raise HTTPException(status_code=403, detail="repository not allowed")
    if (
        settings.allowed_repository_id
        and claims.get("repository_id") != settings.allowed_repository_id
    ):
        raise HTTPException(status_code=403, detail="repository id not allowed")
    if (
        settings.allowed_workflow
        and claims.get("workflow_ref") != settings.allowed_workflow
    ):
        raise HTTPException(status_code=403, detail="workflow not allowed")
    if claims.get("event_name") not in {"release", "workflow_dispatch"}:
        raise HTTPException(status_code=403, detail="event not allowed")
    return claims
