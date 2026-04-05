import os
from collections.abc import AsyncGenerator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://admin:password@localhost:5432/madrigal_db",
)

TASK_TYPE_CONSTRAINT_NAME = "ck_tasks_task_type_allowed"
TASK_TYPE_CONSTRAINT_VALUES = (
    "sys_info",
    "port_scan",
    "ping",
    "agent_snapshot",
    "tcp_connect_check",
    "http_check",
    "list_listening_ports",
    "process_port_inventory",
    "custom_scenario",
    "service_status_check",
    "process_presence_check",
    "port_owner_check",
    "process_resource_snapshot",
    "docker_runtime_access_check",
    "docker_container_status_check",
    "docker_compose_stack_check",
    "docker_port_mapping_check",
)


class Base(DeclarativeBase):
    pass


engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
)

async_session_maker = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        yield session


async def ensure_task_type_constraint() -> None:
    allowed_values = ", ".join(f"'{value}'" for value in TASK_TYPE_CONSTRAINT_VALUES)

    async with engine.begin() as conn:
        await conn.execute(
            text(
                f"ALTER TABLE IF EXISTS tasks DROP CONSTRAINT IF EXISTS {TASK_TYPE_CONSTRAINT_NAME}"
            )
        )
        await conn.execute(
            text(
                "ALTER TABLE IF EXISTS tasks "
                f"ADD CONSTRAINT {TASK_TYPE_CONSTRAINT_NAME} "
                f"CHECK (task_type IN ({allowed_values}))"
            )
        )


async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    await ensure_task_type_constraint()


async def close_db() -> None:
    await engine.dispose()
