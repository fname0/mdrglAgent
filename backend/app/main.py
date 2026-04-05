from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.bootstrap import ensure_default_admin
from app.database import async_session_maker, close_db, init_db
from app.routers import agent_api, auth, frontend_api
from app.routine_service import routine_service


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    await ensure_default_admin(async_session_maker)
    await routine_service.start()
    try:
        yield
    finally:
        await routine_service.stop()
        await close_db()


app = FastAPI(
    title="Madrigal Infrastructure Diagnostics API",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(frontend_api.router)
app.include_router(agent_api.router)


@app.get("/health", tags=["service"])
async def healthcheck() -> dict[str, str]:
    return {"status": "ok"}
