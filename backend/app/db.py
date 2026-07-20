from __future__ import annotations

import os
from typing import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine


def _db_dsn() -> str:
    # Example: mysql+asyncmy://user:pass@mysql:3306/codesprite?charset=utf8mb4
    return os.environ.get("DB_DSN", "").strip()


def create_engine() -> AsyncEngine:
    dsn = _db_dsn()
    if not dsn:
        raise RuntimeError("DB_DSN not configured")
    return create_async_engine(dsn, pool_pre_ping=True, pool_recycle=1800)


def create_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def session_scope(sm: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    async with sm() as s:
        yield s







