import re
from datetime import datetime, date, timedelta
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession
from better_profanity import profanity

from app.db import get_db
from app.models import User, UserMetrics, UserBadge, Badge, MetricsHistory, MetricsHourly, ConcurrencyHistogram
from app.services.ranking import get_user_ranks_with_percentiles, compute_tier

router = APIRouter(prefix="/api/users", tags=["users"])

USERNAME_PATTERN = re.compile(r"^[a-zA-Z0-9_]{3,20}$")


class RegisterRequest(BaseModel):
    user_hash: str


class UsernameRequest(BaseModel):
    username: str


@router.post("")
async def register_user(req: RegisterRequest, db: AsyncSession = Depends(get_db)):
    existing = await db.get(User, req.user_hash)
    if existing:
        return {"status": "exists", "user_hash": existing.user_hash, "username": existing.username}

    user = User(user_hash=req.user_hash, created_at=datetime.utcnow(), updated_at=datetime.utcnow())
    db.add(user)
    await db.commit()
    return {"status": "created", "user_hash": user.user_hash}


@router.put("/{user_hash}/username")
async def set_username(user_hash: str, req: UsernameRequest, db: AsyncSession = Depends(get_db)):
    user = await db.get(User, user_hash)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    username = req.username.strip()
    if not USERNAME_PATTERN.match(username):
        raise HTTPException(
            status_code=400,
            detail="Username must be 3-20 characters, alphanumeric and underscores only",
        )

    if profanity.contains_profanity(username):
        raise HTTPException(status_code=400, detail="Username contains inappropriate language")

    # Check uniqueness (case-insensitive)
    stmt = select(User).where(
        User.username.ilike(username), User.user_hash != user_hash
    )
    result = await db.execute(stmt)
    if result.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Username already taken")

    user.username = username
    user.updated_at = datetime.utcnow()
    await db.commit()
    return {"status": "ok", "username": user.username}


@router.get("/by-username/{username}")
async def get_user_by_username(username: str, db: AsyncSession = Depends(get_db)):
    stmt = select(User).where(User.username.ilike(username))
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return {"user_hash": user.user_hash, "username": user.username}


@router.get("/{user_hash}")
async def get_user_profile(user_hash: str, db: AsyncSession = Depends(get_db)):
    import json

    user = await db.get(User, user_hash)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    metrics = await db.get(UserMetrics, user_hash)
    ranks = await get_user_ranks_with_percentiles(db, user_hash)

    weighted = metrics.weighted_score if metrics else 0
    tier = compute_tier(weighted)

    # Get badges
    stmt = (
        select(UserBadge, Badge)
        .join(Badge, UserBadge.badge_id == Badge.id)
        .where(UserBadge.user_hash == user_hash)
    )
    result = await db.execute(stmt)
    badges = [
        {
            "id": badge.id,
            "name": badge.name,
            "icon": badge.icon,
            "category": badge.category,
            "unlocked_at": ub.unlocked_at.isoformat(),
        }
        for ub, badge in result.all()
    ]

    # Get concurrency stats for today
    today = date.today()
    today_start = datetime(today.year, today.month, today.day, 0, 0, 0)
    today_end = datetime(today.year, today.month, today.day, 23, 59, 59)

    concurrency_stmt = (
        select(ConcurrencyHistogram)
        .where(
            and_(
                ConcurrencyHistogram.user_hash == user_hash,
                ConcurrencyHistogram.snapshot_hour >= today_start,
                ConcurrencyHistogram.snapshot_hour <= today_end,
            )
        )
    )
    concurrency_result = await db.execute(concurrency_stmt)
    concurrency_rows = concurrency_result.scalars().all()

    max_concurrent = 0
    concurrent_mins = 0
    for row in concurrency_rows:
        try:
            histogram = json.loads(row.histogram) if row.histogram else {}
            for sessions_str, minutes in histogram.items():
                session_count = int(sessions_str)
                if session_count > max_concurrent:
                    max_concurrent = session_count
                if session_count > 1:
                    concurrent_mins += minutes
        except (json.JSONDecodeError, ValueError):
            continue

    return {
        "user_hash": user.user_hash,
        "username": user.username,
        "team_hash": user.team_hash,
        "created_at": user.created_at.isoformat(),
        "metrics": {
            "total_tokens": metrics.total_tokens if metrics else 0,
            "total_messages": metrics.total_messages if metrics else 0,
            "total_sessions": metrics.total_sessions if metrics else 0,
            "total_tool_calls": metrics.total_tool_calls if metrics else 0,
            "prompt_uniqueness_score": metrics.prompt_uniqueness_score if metrics else 0,
            "weighted_score": weighted,
            "current_streak": metrics.current_streak if metrics else 0,
            "total_points": metrics.total_points if metrics else 0,
            "level": metrics.level if metrics else 0,
            "last_synced": metrics.last_synced.isoformat() if metrics else None,
            "max_concurrent": max_concurrent,
            "concurrent_mins": concurrent_mins,
        },
        "ranks": ranks,
        "tier": tier,
        "badges": badges,
    }


@router.get("/{user_hash}/history")
async def get_user_history(user_hash: str, days: int = 30, db: AsyncSession = Depends(get_db)):
    stmt = (
        select(MetricsHistory)
        .where(MetricsHistory.user_hash == user_hash)
        .order_by(MetricsHistory.snapshot_date.desc())
        .limit(days)
    )
    result = await db.execute(stmt)
    rows = result.scalars().all()
    return [
        {
            "date": r.snapshot_date.isoformat(),
            "tokens": r.total_tokens,
            "messages": r.total_messages,
            "sessions": r.total_sessions,
            "tool_calls": r.total_tool_calls,
            "uniqueness": r.prompt_uniqueness_score,
            "weighted": r.weighted_score,
        }
        for r in rows
    ]


@router.get("/{user_hash}/badges")
async def get_user_badges(user_hash: str, db: AsyncSession = Depends(get_db)):
    stmt = (
        select(UserBadge, Badge)
        .join(Badge, UserBadge.badge_id == Badge.id)
        .where(UserBadge.user_hash == user_hash)
    )
    result = await db.execute(stmt)
    return [
        {
            "id": badge.id,
            "name": badge.name,
            "description": badge.description,
            "icon": badge.icon,
            "category": badge.category,
            "unlocked_at": ub.unlocked_at.isoformat(),
        }
        for ub, badge in result.all()
    ]


@router.get("/{user_hash}/heatmap/hourly")
async def get_user_hourly_heatmap(
    user_hash: str, hours: int = Query(24, ge=1, le=720), db: AsyncSession = Depends(get_db)
):
    now = datetime.utcnow()
    start_hour = (now - timedelta(hours=hours)).replace(minute=0, second=0, microsecond=0)

    stmt = (
        select(MetricsHourly)
        .where(
            and_(
                MetricsHourly.user_hash == user_hash,
                MetricsHourly.snapshot_hour >= start_hour,
            )
        )
        .order_by(MetricsHourly.snapshot_hour.asc())
    )
    result = await db.execute(stmt)
    snapshots = result.scalars().all()

    snap_map = {s.snapshot_hour: s for s in snapshots}

    # Return stored per-hour message counts directly (not cumulative deltas)
    heatmap = []
    current = start_hour
    while current <= now:
        snap = snap_map.get(current)
        messages = snap.total_messages if snap else 0

        heatmap.append({
            "hour": current.isoformat(),
            "tokens": 0,
            "messages": messages,
            "tool_calls": 0,
            "activity": messages,
        })
        current += timedelta(hours=1)

    activities = [d["activity"] for d in heatmap if d["activity"] > 0]
    if activities:
        activities.sort()
        q1 = activities[len(activities) // 4] if len(activities) > 3 else activities[0]
        q2 = activities[len(activities) // 2] if len(activities) > 1 else activities[0]
        q3 = activities[len(activities) * 3 // 4] if len(activities) > 3 else activities[-1]
        for d in heatmap:
            a = d["activity"]
            if a == 0:
                d["intensity"] = 0
            elif a <= q1:
                d["intensity"] = 1
            elif a <= q2:
                d["intensity"] = 2
            elif a <= q3:
                d["intensity"] = 3
            else:
                d["intensity"] = 4
    else:
        for d in heatmap:
            d["intensity"] = 0

    return heatmap


@router.get("/{user_hash}/heatmap")
async def get_user_heatmap(
    user_hash: str, days: int = Query(365, ge=1, le=730), db: AsyncSession = Depends(get_db)
):
    today = date.today()
    start_date = today - timedelta(days=days)

    stmt = (
        select(MetricsHistory)
        .where(
            and_(
                MetricsHistory.user_hash == user_hash,
                MetricsHistory.snapshot_date >= start_date,
            )
        )
        .order_by(MetricsHistory.snapshot_date.asc())
    )
    result = await db.execute(stmt)
    snapshots = result.scalars().all()

    # Build a map of date -> snapshot
    snap_map = {s.snapshot_date: s for s in snapshots}

    # Use stored per-day counts when available, fall back to cumulative deltas
    heatmap = []
    prev = None
    current = start_date
    while current <= today:
        snap = snap_map.get(current)
        if snap and getattr(snap, "daily_messages", 0) > 0:
            # Direct per-day counts from daily_activity sync
            messages = snap.daily_messages
            tool_calls = getattr(snap, "daily_tool_calls", 0) or 0
            tokens = 0
            activity = messages
        elif snap and prev:
            tokens = max(0, snap.total_tokens - prev.total_tokens)
            messages = max(0, snap.total_messages - prev.total_messages)
            tool_calls = max(0, snap.total_tool_calls - prev.total_tool_calls)
            activity = tokens + messages * 1000 + tool_calls * 500
        else:
            tokens = 0
            messages = 0
            tool_calls = 0
            activity = 0

        heatmap.append({
            "date": current.isoformat(),
            "tokens": tokens,
            "messages": messages,
            "tool_calls": tool_calls,
            "activity": activity,
        })

        if snap:
            prev = snap
        current += timedelta(days=1)

    # Compute intensity levels (0-4) based on quartiles of non-zero activity
    activities = [d["activity"] for d in heatmap if d["activity"] > 0]
    if activities:
        activities.sort()
        q1 = activities[len(activities) // 4] if len(activities) > 3 else activities[0]
        q2 = activities[len(activities) // 2] if len(activities) > 1 else activities[0]
        q3 = activities[len(activities) * 3 // 4] if len(activities) > 3 else activities[-1]
        for d in heatmap:
            a = d["activity"]
            if a == 0:
                d["intensity"] = 0
            elif a <= q1:
                d["intensity"] = 1
            elif a <= q2:
                d["intensity"] = 2
            elif a <= q3:
                d["intensity"] = 3
            else:
                d["intensity"] = 4
    else:
        for d in heatmap:
            d["intensity"] = 0

    return heatmap


@router.get("/{user_hash}/concurrency")
async def get_user_concurrency(user_hash: str, hours: int = Query(12, ge=1, le=24), db: AsyncSession = Depends(get_db)):
    """
    Return per-hour peak concurrency data for the last N hours.
    Returns: { "YYYY-MM-DD:HH": peak_concurrent_sessions, ... }
    """
    import json

    now = datetime.utcnow()
    start_time = now - timedelta(hours=hours)

    stmt = (
        select(ConcurrencyHistogram)
        .where(
            and_(
                ConcurrencyHistogram.user_hash == user_hash,
                ConcurrencyHistogram.snapshot_hour >= start_time,
            )
        )
    )
    result = await db.execute(stmt)
    rows = result.scalars().all()

    # Return per-hour peak concurrency
    per_hour = {}
    for row in rows:
        try:
            histogram = json.loads(row.histogram) if row.histogram else {}
            # Find peak concurrency for this hour
            peak = 0
            for sessions_str, minutes in histogram.items():
                s = int(sessions_str)
                if s > peak:
                    peak = s
            # Format key as "YYYY-MM-DD:HH"
            hour_key = f"{row.snapshot_hour.strftime('%Y-%m-%d')}:{row.snapshot_hour.hour}"
            per_hour[hour_key] = peak
        except (json.JSONDecodeError, ValueError):
            continue

    return per_hour
