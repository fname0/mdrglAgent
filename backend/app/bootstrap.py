from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import User
from app.security import hash_password


async def ensure_default_admin(session_factory: async_sessionmaker[AsyncSession]) -> None:
    async with session_factory() as session:
        result = await session.execute(select(User).where(User.username == "admin"))
        existing = result.scalar_one_or_none()
        if existing:
            return

        session.add(
            User(
                username="admin",
                hashed_password=hash_password("admin"),
            )
        )
        await session.commit()
