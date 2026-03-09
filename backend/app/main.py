from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.db import init_db, async_session
from app.routes import users, teams, sync, leaderboard, badges, hot
from app.services.badge_engine import seed_badges


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    async with async_session() as db:
        await seed_badges(db)
    yield


app = FastAPI(title="Oto Ranking API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://claude-rank.onrender.com",
        "https://clauderank.com",
        "https://www.clauderank.com",
        "http://localhost:3000",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(users.router)
app.include_router(teams.router)
app.include_router(sync.router)
app.include_router(leaderboard.router)
app.include_router(badges.router)
app.include_router(hot.router)


@app.get("/api")
async def root():
    return {"service": "Oto Ranking API", "version": "1.0.0"}

# Serve the static website (must be after API routes)
# Works from both local dev (backend/app/main.py → ../../website) and repo root
for _candidate in [
    Path(__file__).resolve().parent.parent.parent / "website",
    Path(__file__).resolve().parent.parent / "website",
]:
    if _candidate.is_dir():
        app.mount("/", StaticFiles(directory=str(_candidate), html=True), name="website")
        break
