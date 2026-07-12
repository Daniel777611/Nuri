"""JWT auth + per-user soft scoping helpers."""

import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Literal, Optional

import bcrypt
import jwt
from dotenv import load_dotenv
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret")
JWT_ALGORITHM = os.environ.get("JWT_ALGORITHM", "HS256")
JWT_EXPIRES_MINUTES = int(os.environ.get("JWT_EXPIRES_MINUTES", "10080"))

ParentRole = Literal["mom", "dad", "grandparent", "other"]


class UserPublic(BaseModel):
    id: str
    email: EmailStr
    nickname: str = ""
    city: str = ""
    parent_role: ParentRole = "mom"
    top_concerns: List[str] = Field(default_factory=list)
    concern_other: str = ""
    hobbies: str = ""
    help_preference: str = ""
    info_source: str = ""
    content_frequency: str = ""
    onboarding_completed: bool = False
    created_at: str


class UserRegister(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=6, max_length=128)
    nickname: str = Field("", max_length=50)
    city: str = Field("", max_length=100)
    parent_role: ParentRole = "mom"
    top_concerns: List[str] = Field(default_factory=list)


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserUpdate(BaseModel):
    nickname: Optional[str] = None
    city: Optional[str] = None
    parent_role: Optional[ParentRole] = None
    top_concerns: Optional[List[str]] = None
    concern_other: Optional[str] = None
    hobbies: Optional[str] = None
    help_preference: Optional[str] = None
    info_source: Optional[str] = None
    content_frequency: Optional[str] = None
    onboarding_completed: Optional[bool] = None


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
        "concern_other": "",
        "hobbies": "",
        "help_preference": "",
        "info_source": "",
        "content_frequency": "",
        "onboarding_completed": False,
        "hashed_password": hash_password(payload.password),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def to_public(doc: dict) -> UserPublic:
    return UserPublic(
        id=doc["id"],
        email=doc["email"],
        nickname=doc.get("nickname", ""),
        city=doc.get("city", ""),
        parent_role=doc.get("parent_role", "other"),
        top_concerns=doc.get("top_concerns", []),
        concern_other=doc.get("concern_other", ""),
        hobbies=doc.get("hobbies", ""),
        help_preference=doc.get("help_preference", ""),
        info_source=doc.get("info_source", ""),
        content_frequency=doc.get("content_frequency", ""),
        onboarding_completed=doc.get("onboarding_completed", False),
        created_at=doc["created_at"],
    )
