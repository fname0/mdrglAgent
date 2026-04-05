from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db_session
from app.models import User
from app.security import auth_scheme, decode_token


async def get_current_user(
    credentials=Depends(auth_scheme),
    session: AsyncSession = Depends(get_db_session),
) -> User:
    token_payload = decode_token(credentials)
    result = await session.execute(select(User).where(User.username == token_payload.sub))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )
    return user
