from __future__ import annotations
from datetime import datetime, date
from typing import Optional, List, Dict
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db, DATABASE_URL
from app.models import User, UserMetrics, MetricsHistory, MetricsHourly
from app.services.ranking import compute_weighted_score
from app.services.badge_engine import (
    evaluate_milestone_badges,
    evaluate_ranking_badges,
    evaluate_team_badges,
)

router = APIRouter(prefix="/api", tags=["sync"])

PRICING = [
    {"match": "opus-4-6",  "input": 5,    "output": 25,   "cache_read": 0.50, "cache_write": 6.25},
    {"match": "opus-4-5",  "input": 5,    "output": 25,   "cache_read": 0.50, "cache_write": 6.25},
    {"match": "opus-4-1",  "input": 15,   "output": 75,   "cache_read": 1.50, "cache_write": 18.75},
    {"match": "opus-4-0",  "input": 15,   "output": 75,   "cache_read": 1.50, "cache_write": 18.75},
    {"match": "opus-4",    "input": 15,   "output": 75,   "cache_read": 1.50, "cache_write": 18.75},
    {"match": "opus-3",    "input": 15,   "output": 75,   "cache_read": 1.50, "cache_write": 18.75},
    {"match": "sonnet",    "input": 3,    "output": 15,   "cache_read": 0.30, "cache_write": 3.75},
    {"match": "haiku-4-5", "input": 1,    "output": 5,    "cache_read": 0.10, "cache_write": 1.25},
    {"match": "haiku-4",   "input": 1,    "output": 5,    "cache_read": 0.10, "cache_write": 1.25},
    {"match": "haiku-3-5", "input": 0.80, "output": 4,    "cache_read": 0.08, "cache_write": 1},
    {"match": "haiku-3",   "input": 0.25, "output": 1.25, "cache_read": 0.03, "cache_write": 0.30},
]
FALLBACK_PRICE = {"input": 3, "output": 15, "cache_read": 0.30, "cache_write": 3.75}


def estimate_cost(token_breakdown: dict) -> float:
    cost = 0.0
    for model, usage in token_breakdown.items():
        tier = next((p for p in PRICING if p["match"] in model), FALLBACK_PRICE)
        cost += (
            (usage.get("input", 0) * tier["input"]
             + usage.get("output", 0) * tier["output"]
             + usage.get("cache_read", 0) * tier["cache_read"]
             + usage.get("cache_creation", 0) * tier["cache_write"])
            / 1_000_000
        )
    return round(cost, 2)

IS_SQLITE = DATABASE_URL.startswith("sqlite")


class SyncTotals(BaseModel):
    total_tokens: int = 0
    total_messages: int = 0
    total_sessions: int = 0
    total_tool_calls: int = 0
    current_streak: int = 0
    total_points: int = 0
    level: int = 0


class SyncRequest(BaseModel):
    user_hash: str
    sync_settings: Optional[Dict] = None
    totals: SyncTotals
    token_breakdown: Optional[Dict] = None
    daily_activity: Optional[List] = None
    hour_counts: Optional[Dict] = None
    prompt_hashes: Optional[List[str]] = None
    prompts: Optional[List[str]] = None
    tool_names: Optional[List[str]] = None


@router.post("/sync")
async def sync_metrics(req: SyncRequest, db: AsyncSession = Depends(get_db)):
    # Ensure user exists
    user = await db.get(User, req.user_hash)
    if not user:
        user = User(user_hash=req.user_hash, created_at=datetime.utcnow(), updated_at=datetime.utcnow())
        db.add(user)
        await db.flush()

    # Compute prompt uniqueness from hashes
    prompt_uniqueness = 0.0
    if req.prompt_hashes:
        unique_count = len(set(req.prompt_hashes))
        total_count = len(req.prompt_hashes)
        prompt_uniqueness = unique_count / total_count if total_count > 0 else 0.0

    weighted = compute_weighted_score(
        req.totals.total_tokens,
        req.totals.total_messages,
        req.totals.total_sessions,
        req.totals.total_tool_calls,
        prompt_uniqueness,
    )

    estimated_spend = estimate_cost(req.token_breakdown) if req.token_breakdown else 0.0

    now = datetime.utcnow()
    today = date.today()

    # Upsert user_metrics
    existing_metrics = await db.get(UserMetrics, req.user_hash)
    if existing_metrics:
        existing_metrics.total_tokens = req.totals.total_tokens
        existing_metrics.total_messages = req.totals.total_messages
        existing_metrics.total_sessions = req.totals.total_sessions
        existing_metrics.total_tool_calls = req.totals.total_tool_calls
        existing_metrics.prompt_uniqueness_score = prompt_uniqueness
        existing_metrics.weighted_score = weighted
        existing_metrics.estimated_spend = estimated_spend
        existing_metrics.current_streak = req.totals.current_streak
        existing_metrics.total_points = req.totals.total_points
        existing_metrics.level = req.totals.level
        existing_metrics.last_synced = now
    else:
        db.add(UserMetrics(
            user_hash=req.user_hash,
            total_tokens=req.totals.total_tokens,
            total_messages=req.totals.total_messages,
            total_sessions=req.totals.total_sessions,
            total_tool_calls=req.totals.total_tool_calls,
            prompt_uniqueness_score=prompt_uniqueness,
            weighted_score=weighted,
            estimated_spend=estimated_spend,
            current_streak=req.totals.current_streak,
            total_points=req.totals.total_points,
            level=req.totals.level,
            last_synced=now,
        ))

    # Upsert daily snapshot
    hist_stmt = select(MetricsHistory).where(
        MetricsHistory.user_hash == req.user_hash,
        MetricsHistory.snapshot_date == today,
    )
    result = await db.execute(hist_stmt)
    existing_hist = result.scalar_one_or_none()
    if existing_hist:
        existing_hist.total_tokens = req.totals.total_tokens
        existing_hist.total_messages = req.totals.total_messages
        existing_hist.total_sessions = req.totals.total_sessions
        existing_hist.total_tool_calls = req.totals.total_tool_calls
        existing_hist.prompt_uniqueness_score = prompt_uniqueness
        existing_hist.weighted_score = weighted
    else:
        db.add(MetricsHistory(
            user_hash=req.user_hash,
            snapshot_date=today,
            total_tokens=req.totals.total_tokens,
            total_messages=req.totals.total_messages,
            total_sessions=req.totals.total_sessions,
            total_tool_calls=req.totals.total_tool_calls,
            prompt_uniqueness_score=prompt_uniqueness,
            weighted_score=weighted,
        ))

    # Persist hour_counts: actual per-hour message counts
    if req.hour_counts:
        for hour_str, count in req.hour_counts.items():
            try:
                if ':' in hour_str:
                    # New format: "2026-03-05:14" → parse date and hour
                    parts = hour_str.rsplit(':', 1)
                    d = date.fromisoformat(parts[0])
                    h = int(parts[1])
                    snapshot_hour = datetime(d.year, d.month, d.day, h, 0, 0)
                else:
                    # Old format: "14" → attribute to today
                    h = int(hour_str)
                    snapshot_hour = now.replace(hour=h, minute=0, second=0, microsecond=0)
            except (ValueError, TypeError):
                continue
            if not (0 <= h <= 23) or count <= 0:
                continue
            hourly_stmt = select(MetricsHourly).where(
                MetricsHourly.user_hash == req.user_hash,
                MetricsHourly.snapshot_hour == snapshot_hour,
            )
            result_hourly = await db.execute(hourly_stmt)
            existing_hourly = result_hourly.scalar_one_or_none()
            if existing_hourly:
                existing_hourly.total_messages = count
            else:
                db.add(MetricsHourly(
                    user_hash=req.user_hash,
                    snapshot_hour=snapshot_hour,
                    total_messages=count,
                ))

    # Persist daily_activity: actual per-day message/tool counts
    if req.daily_activity:
        for entry in req.daily_activity:
            if not isinstance(entry, dict) or "date" not in entry:
                continue
            try:
                entry_date = date.fromisoformat(entry["date"])
            except (ValueError, TypeError):
                continue
            msg_count = entry.get("messageCount", 0) or 0
            tool_count = entry.get("toolCallCount", 0) or 0
            if msg_count <= 0 and tool_count <= 0:
                continue
            day_stmt = select(MetricsHistory).where(
                MetricsHistory.user_hash == req.user_hash,
                MetricsHistory.snapshot_date == entry_date,
            )
            day_result = await db.execute(day_stmt)
            existing_day = day_result.scalar_one_or_none()
            if existing_day:
                existing_day.daily_messages = msg_count
                existing_day.daily_tool_calls = tool_count
            else:
                db.add(MetricsHistory(
                    user_hash=req.user_hash,
                    snapshot_date=entry_date,
                    daily_messages=msg_count,
                    daily_tool_calls=tool_count,
                ))

    await db.flush()

    # Evaluate badges
    metrics = await db.get(UserMetrics, req.user_hash)
    new_badges = []
    new_badges.extend(await evaluate_milestone_badges(db, req.user_hash, metrics))
    new_badges.extend(await evaluate_ranking_badges(db, req.user_hash))
    new_badges.extend(await evaluate_team_badges(db, req.user_hash))

    await db.commit()

    return {
        "status": "ok",
        "weighted_score": weighted,
        "prompt_uniqueness_score": prompt_uniqueness,
        "new_badges": new_badges,
    }
