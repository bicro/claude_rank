from __future__ import annotations
import json
from datetime import date, datetime, timedelta
from typing import Optional, Dict, Any
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession
from app.models import UserMetrics, User, MetricsHistory, ConcurrencyHistogram

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


def _rank_entry(rank: int, total: int) -> dict:
    return {"rank": rank, "percentile": compute_percentile(rank, total), "total_users": total}


async def get_daily_ranks_for_user(
    db: AsyncSession, user_hash: str, target_date: date
) -> dict[str, Any]:
    """Compute daily ranks for a user on a given date."""
    ranks: dict[str, Any] = {}

    # --- daily_tokens / daily_spend rank ---
    stmt = select(MetricsHistory.user_hash, MetricsHistory.daily_tokens).where(
        and_(MetricsHistory.snapshot_date == target_date, MetricsHistory.daily_tokens > 0)
    )
    result = await db.execute(stmt)
    token_rows = result.all()

    user_tokens = None
    for row in token_rows:
        if row.user_hash == user_hash:
            user_tokens = row.daily_tokens
            break

    if user_tokens is not None and user_tokens > 0:
        total = len(token_rows)
        higher = sum(1 for r in token_rows if r.daily_tokens > user_tokens)
        rank = higher + 1
        entry = _rank_entry(rank, total)
        ranks["daily_tokens"] = entry
        ranks["daily_spend"] = entry
    else:
        ranks["daily_tokens"] = None
        ranks["daily_spend"] = None

    # --- concurrency metrics from ConcurrencyHistogram ---
    day_start = datetime(target_date.year, target_date.month, target_date.day, 0, 0, 0)
    day_end = datetime(target_date.year, target_date.month, target_date.day, 23, 59, 59)

    conc_stmt = select(ConcurrencyHistogram).where(
        and_(
            ConcurrencyHistogram.snapshot_hour >= day_start,
            ConcurrencyHistogram.snapshot_hour <= day_end,
        )
    )
    conc_result = await db.execute(conc_stmt)
    conc_rows = conc_result.scalars().all()

    # Aggregate per user: peak, active_mins, concurrent_mins
    user_stats: dict[str, dict] = {}
    for row in conc_rows:
        try:
            histogram = json.loads(row.histogram) if row.histogram else {}
        except (json.JSONDecodeError, ValueError):
            continue
        uh = row.user_hash
        if uh not in user_stats:
            user_stats[uh] = {"peak": 0, "active_mins": 0, "concurrent_mins": 0}

        for sessions_str, minutes in histogram.items():
            session_count = int(sessions_str)
            if session_count > user_stats[uh]["peak"]:
                user_stats[uh]["peak"] = session_count
            if session_count >= 1:
                user_stats[uh]["active_mins"] += minutes
            if session_count > 1:
                user_stats[uh]["concurrent_mins"] += minutes

    my_stats = user_stats.get(user_hash)
    active_users = [s for s in user_stats.values() if s["peak"] > 0]
    total_conc = len(active_users)

    if my_stats and my_stats["peak"] > 0:
        higher = sum(1 for s in active_users if s["peak"] > my_stats["peak"])
        ranks["peak_concurrency"] = _rank_entry(higher + 1, total_conc)
    else:
        ranks["peak_concurrency"] = None

    if my_stats and my_stats["active_mins"] > 0:
        active_list = [s for s in user_stats.values() if s["active_mins"] > 0]
        higher = sum(1 for s in active_list if s["active_mins"] > my_stats["active_mins"])
        ranks["active_mins"] = _rank_entry(higher + 1, len(active_list))
    else:
        ranks["active_mins"] = None

    if my_stats and my_stats["concurrent_mins"] > 0:
        conc_list = [s for s in user_stats.values() if s["concurrent_mins"] > 0]
        higher = sum(1 for s in conc_list if s["concurrent_mins"] > my_stats["concurrent_mins"])
        ranks["concurrent_mins"] = _rank_entry(higher + 1, len(conc_list))
    else:
        ranks["concurrent_mins"] = None

    return ranks


async def get_weekly_ranks_for_user(
    db: AsyncSession, user_hash: str, week_end_date: date
) -> dict[str, Any]:
    """Compute weekly ranks for a user over a 7-day window ending on week_end_date."""
    ranks: dict[str, Any] = {}
    week_start = week_end_date - timedelta(days=6)

    # --- avg_spend (rank by total tokens over 7 days, same ordering as avg) ---
    stmt = (
        select(MetricsHistory.user_hash, func.sum(MetricsHistory.daily_tokens).label("total"))
        .where(
            and_(
                MetricsHistory.snapshot_date >= week_start,
                MetricsHistory.snapshot_date <= week_end_date,
                MetricsHistory.daily_tokens > 0,
            )
        )
        .group_by(MetricsHistory.user_hash)
    )
    result = await db.execute(stmt)
    token_sums = result.all()

    user_total = None
    for row in token_sums:
        if row.user_hash == user_hash:
            user_total = row.total
            break

    if user_total is not None and user_total > 0:
        total = len(token_sums)
        higher = sum(1 for r in token_sums if r.total > user_total)
        ranks["avg_spend"] = _rank_entry(higher + 1, total)
    else:
        ranks["avg_spend"] = None

    # --- peak_avg: average of daily peak concurrency across active days ---
    day_start_dt = datetime(week_start.year, week_start.month, week_start.day, 0, 0, 0)
    day_end_dt = datetime(week_end_date.year, week_end_date.month, week_end_date.day, 23, 59, 59)

    conc_stmt = select(ConcurrencyHistogram).where(
        and_(
            ConcurrencyHistogram.snapshot_hour >= day_start_dt,
            ConcurrencyHistogram.snapshot_hour <= day_end_dt,
        )
    )
    conc_result = await db.execute(conc_stmt)
    conc_rows = conc_result.scalars().all()

    # Per user, per day: compute peak, then average across days
    user_day_peaks: dict[str, dict[date, int]] = {}
    for row in conc_rows:
        try:
            histogram = json.loads(row.histogram) if row.histogram else {}
        except (json.JSONDecodeError, ValueError):
            continue
        uh = row.user_hash
        d = row.snapshot_hour.date()
        if uh not in user_day_peaks:
            user_day_peaks[uh] = {}
        for sessions_str in histogram:
            sc = int(sessions_str)
            if sc > user_day_peaks[uh].get(d, 0):
                user_day_peaks[uh][d] = sc

    # Compute average peak per user
    user_peak_avgs: dict[str, float] = {}
    for uh, day_map in user_day_peaks.items():
        if day_map:
            user_peak_avgs[uh] = sum(day_map.values()) / len(day_map)

    my_avg = user_peak_avgs.get(user_hash)
    if my_avg is not None and my_avg > 0:
        active_avgs = [v for v in user_peak_avgs.values() if v > 0]
        total = len(active_avgs)
        higher = sum(1 for v in active_avgs if v > my_avg)
        ranks["peak_avg"] = _rank_entry(higher + 1, total)
    else:
        ranks["peak_avg"] = None

    return ranks
