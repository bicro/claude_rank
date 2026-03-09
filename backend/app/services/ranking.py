from __future__ import annotations
from typing import Optional, Dict, Any
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.models import UserMetrics, User

TIER_THRESHOLDS = [
    {"tier": "Diamond", "min": 1000},
    {"tier": "Platinum", "min": 500},
    {"tier": "Gold", "min": 200},
    {"tier": "Silver", "min": 50},
    {"tier": "Bronze", "min": 0},
]

TIER_ORDER = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"]


def compute_tier(weighted_score: float) -> dict:
    for i, t in enumerate(TIER_THRESHOLDS):
        if weighted_score >= t["min"]:
            tier_name = t["tier"]
            idx = TIER_ORDER.index(tier_name)
            if idx < len(TIER_ORDER) - 1:
                next_tier = TIER_ORDER[idx + 1]
                next_min = TIER_THRESHOLDS[len(TIER_THRESHOLDS) - 2 - idx]["min"]
                progress = (weighted_score - t["min"]) / (next_min - t["min"])
                progress = min(progress, 1.0)
            else:
                next_tier = None
                progress = 1.0
            return {"tier": tier_name, "next_tier": next_tier, "progress": round(progress, 2)}
    return {"tier": "Bronze", "next_tier": "Silver", "progress": 0.0}


async def get_total_user_count(db: AsyncSession) -> int:
    result = await db.execute(select(func.count()).select_from(UserMetrics))
    return result.scalar_one()


def compute_percentile(rank: int, total: int) -> float:
    if total <= 1:
        return 0.0
    return round(((rank - 1) / (total - 1)) * 100, 1)

CATEGORY_COLUMNS = {
    "tokens": UserMetrics.total_tokens,
    "messages": UserMetrics.total_messages + UserMetrics.total_sessions,
    "tools": UserMetrics.total_tool_calls,
    "uniqueness": UserMetrics.prompt_uniqueness_score,
    "weighted": UserMetrics.weighted_score,
}

WEIGHTED_FORMULA = {
    "tokens": 0.3,
    "messages": 0.2,
    "sessions": 0.1,
    "tool_calls": 0.25,
    "uniqueness": 0.15,
}


def compute_weighted_score(
    total_tokens: int,
    total_messages: int,
    total_sessions: int,
    total_tool_calls: int,
    prompt_uniqueness_score: float,
) -> float:
    return (
        (total_tokens / 1_000_000) * WEIGHTED_FORMULA["tokens"]
        + total_messages * WEIGHTED_FORMULA["messages"]
        + total_sessions * WEIGHTED_FORMULA["sessions"]
        + total_tool_calls * WEIGHTED_FORMULA["tool_calls"]
        + prompt_uniqueness_score * 100 * WEIGHTED_FORMULA["uniqueness"]
    )


async def get_user_rank(db: AsyncSession, user_hash: str, category: str) -> Optional[int]:
    if category not in CATEGORY_COLUMNS:
        return None
    col = CATEGORY_COLUMNS[category]
    user_metrics = await db.get(UserMetrics, user_hash)
    if not user_metrics:
        return None

    user_value = col
    # Get the actual value for this user
    stmt = select(col).where(UserMetrics.user_hash == user_hash)
    result = await db.execute(stmt)
    val = result.scalar_one_or_none()
    if val is None:
        return None

    # Count how many have a higher value
    count_stmt = select(func.count()).select_from(UserMetrics).where(col > val)
    count_result = await db.execute(count_stmt)
    rank = count_result.scalar_one() + 1
    return rank


async def get_user_ranks(db: AsyncSession, user_hash: str) -> dict[str, Optional[int]]:
    ranks = {}
    for cat in CATEGORY_COLUMNS:
        ranks[cat] = await get_user_rank(db, user_hash, cat)
    return ranks


async def get_user_ranks_with_percentiles(db: AsyncSession, user_hash: str) -> dict[str, Any]:
    ranks = await get_user_ranks(db, user_hash)
    total = await get_total_user_count(db)
    result = {}
    for cat, rank in ranks.items():
        if rank is not None:
            result[cat] = {
                "rank": rank,
                "percentile": compute_percentile(rank, total),
                "total_users": total,
            }
        else:
            result[cat] = None
    return result
