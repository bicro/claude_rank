from __future__ import annotations
from datetime import date, timedelta
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession
from app.models import UserMetrics, MetricsHistory, User


async def get_hot_users(db: AsyncSession, limit: int = 20, lookback_days: int = 3) -> list[dict]:
    # Get users with active streaks
    stmt = (
        select(UserMetrics, User.username)
        .join(User, User.user_hash == UserMetrics.user_hash)
        .where(UserMetrics.current_streak > 0)
    )
    result = await db.execute(stmt)
    rows = result.all()

    if not rows:
        return []

    today = date.today()
    lookback_date = today - timedelta(days=lookback_days)

    hot_users = []
    for metrics, username in rows:
        # Get token velocity from history
        hist_stmt = (
            select(MetricsHistory)
            .where(
                and_(
                    MetricsHistory.user_hash == metrics.user_hash,
                    MetricsHistory.snapshot_date >= lookback_date,
                )
            )
            .order_by(MetricsHistory.snapshot_date.asc())
        )
        hist_result = await db.execute(hist_stmt)
        history = hist_result.scalars().all()

        velocity = 0.0
        if len(history) >= 2:
            token_delta = history[-1].total_tokens - history[0].total_tokens
            velocity = token_delta / lookback_days if lookback_days > 0 else 0

        velocity_score = velocity / 100_000
        hotness = metrics.current_streak * 10 + velocity_score * 50

        hot_users.append({
            "user_hash": metrics.user_hash,
            "username": username,
            "current_streak": metrics.current_streak,
            "total_points": metrics.total_points,
            "level": metrics.level,
            "weighted_score": metrics.weighted_score,
            "hotness": round(hotness, 2),
        })

    hot_users.sort(key=lambda u: u["hotness"], reverse=True)
    return hot_users[:limit]
