"""JWT auth + per-user soft scoping helpers."""

import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Literal, Optional

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field


JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret")
JWT_ALGORITHM = os.environ.get("JWT_ALGORITHM", "HS256")
JWT_EXPIRES_MINUTES = int(os.environ.get("JWT_EXPIRES_MINUTES", "10080"))

ParentRole = Literal["mom", "dad", "grandparent", "other"]
Concern = Literal["sleep", "food", "emotion", "health", "education"]


class UserPublic(BaseModel):
    id: str
    email: EmailStr
    nickname: str
    city: str
    parent_role: ParentRole
    top_concerns: List[Concern] = Field(default_factory=list)
    created_at: str


class UserRegister(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=6, max_length=128)
    nickname: str = Field(..., min_length=1, max_length=50)
    city: str = Field(..., min_length=1, max_length=100)
    parent_role: ParentRole = "mom"
    top_concerns: List[Concern] = Field(default_factory=list)


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserUpdate(BaseModel):
    nickname: Optional[str] = None
    city: Optional[str] = None
    parent_role: Optional[ParentRole] = None
    top_concerns: Optional[List[Concern]] = None


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPublic


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_access_token(user_id: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "iat": now,
        "exp": now + timedelta(minutes=JWT_EXPIRES_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload.get("sub")
    except jwt.PyJWTError:
        return None


bearer = HTTPBearer(auto_error=False)


async def get_optional_user_id(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer),
) -> Optional[str]:
    """Return user_id if a valid bearer token is present, else None.

    Soft-scope: existing endpoints continue to work without a token (legacy
    documents have no user_id) but will be auto-scoped when a token is sent.
    """
    if not creds or creds.scheme.lower() != "bearer":
        return None
    return decode_token(creds.credentials)


async def require_user_id(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer),
) -> str:
    if not creds or creds.scheme.lower() != "bearer":
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    uid = decode_token(creds.credentials)
    if not uid:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return uid


def scope_filter(user_id: Optional[str], legacy_visible: bool = True) -> dict:
    """Filter to scope a collection by user_id. If no user_id, returns {}.

    legacy_visible=True: documents lacking a user_id are still returned to
    authed users — useful for the prototype's pre-existing mock data.
    """
    if not user_id:
        return {}
    if legacy_visible:
        return {"$or": [{"user_id": user_id}, {"user_id": {"$exists": False}}]}
    return {"user_id": user_id}


def new_user_doc(payload: UserRegister) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "email": payload.email.lower(),
        "nickname": payload.nickname,
        "city": payload.city,
        "parent_role": payload.parent_role,
        "top_concerns": payload.top_concerns,
        "hashed_password": hash_password(payload.password),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def to_public(doc: dict) -> UserPublic:
    return UserPublic(
        id=doc["id"],
        email=doc["email"],
        nickname=doc["nickname"],
        city=doc["city"],
        parent_role=doc.get("parent_role", "other"),
        top_concerns=doc.get("top_concerns", []),
        created_at=doc["created_at"],
    )
