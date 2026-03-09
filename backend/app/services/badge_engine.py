from __future__ import annotations
from datetime import datetime
from typing import Optional, List
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.models import Badge, UserBadge, UserMetrics, User

MILESTONE_BADGES = [
    {"id": "first_steps", "name": "First Steps", "description": "Send your first message", "icon": "🚀", "field": "total_messages", "threshold": 1},
    {"id": "thousand_club", "name": "Thousand Club", "description": "Send 1,000 messages", "icon": "💬", "field": "total_messages", "threshold": 1000},
    {"id": "token_millionaire", "name": "Token Millionaire", "description": "Use 1M total tokens", "icon": "🪙", "field": "total_tokens", "threshold": 1_000_000},
    {"id": "token_billionaire", "name": "Token Billionaire", "description": "Use 1B total tokens", "icon": "💎", "field": "total_tokens", "threshold": 1_000_000_000},
    {"id": "tool_master", "name": "Tool Master", "description": "Make 1,000 tool calls", "icon": "🔧", "field": "total_tool_calls", "threshold": 1000},
    {"id": "tool_surgeon", "name": "Tool Surgeon", "description": "Make 10,000 tool calls", "icon": "⚔️", "field": "total_tool_calls", "threshold": 10000},
    {"id": "centurion", "name": "Centurion", "description": "Complete 100 sessions", "icon": "🏛️", "field": "total_sessions", "threshold": 100},
]

RANKING_BADGES_CONFIG = [
    {"id": "top_100", "name": "Top 100", "description": "Rank in top 100 in any category", "icon": "📊", "top_n": 100},
    {"id": "top_10", "name": "Top 10", "description": "Rank in top 10 in any category", "icon": "🏅", "top_n": 10},
    {"id": "number_1", "name": "#1", "description": "Hold #1 rank in any category", "icon": "👑", "top_n": 1},
    {"id": "token_whale", "name": "Token Whale", "description": "Top 10 in token burning", "icon": "🐋", "top_n": 10, "category": "tokens"},
    {"id": "chatterbox", "name": "Chatterbox", "description": "Top 10 in messages + sessions", "icon": "🗣️", "top_n": 10, "category": "messages"},
    {"id": "toolsmith", "name": "Toolsmith", "description": "Top 10 in tool calls", "icon": "🛠️", "top_n": 10, "category": "tools"},
]

TEAM_BADGES_CONFIG = [
    {"id": "team_player", "name": "Team Player", "description": "Join a team", "icon": "🤝"},
]

ALL_BADGES = (
    [{"category": "milestone", **b} for b in MILESTONE_BADGES]
    + [{"category": "ranking", **b} for b in RANKING_BADGES_CONFIG]
    + [{"category": "team", **b} for b in TEAM_BADGES_CONFIG]
)


async def seed_badges(db: AsyncSession):
    for b in ALL_BADGES:
        existing = await db.get(Badge, b["id"])
        if not existing:
            badge = Badge(
                id=b["id"],
                name=b["name"],
                description=b["description"],
                category=b["category"],
                icon=b.get("icon"),
            )
            db.add(badge)
    await db.commit()


async def _award_badge(db: AsyncSession, user_hash: str, badge_id: str) -> Optional[str]:
    existing = await db.get(UserBadge, (user_hash, badge_id))
    if existing:
        return None
    ub = UserBadge(user_hash=user_hash, badge_id=badge_id, unlocked_at=datetime.utcnow())
    db.add(ub)
    return badge_id


async def evaluate_milestone_badges(
    db: AsyncSession, user_hash: str, metrics: UserMetrics
) -> List[str]:
    newly_awarded = []
    for badge_def in MILESTONE_BADGES:
        value = getattr(metrics, badge_def["field"], 0)
        if value >= badge_def["threshold"]:
            result = await _award_badge(db, user_hash, badge_def["id"])
            if result:
                newly_awarded.append(result)
    return newly_awarded


async def evaluate_ranking_badges(db: AsyncSession, user_hash: str) -> List[str]:
    newly_awarded = []
    category_columns = {
        "tokens": UserMetrics.total_tokens,
        "messages": UserMetrics.total_messages + UserMetrics.total_sessions,
        "tools": UserMetrics.total_tool_calls,
        "uniqueness": UserMetrics.prompt_uniqueness_score,
        "weighted": UserMetrics.weighted_score,
    }

    for badge_def in RANKING_BADGES_CONFIG:
        top_n = badge_def["top_n"]
        cats = [badge_def["category"]] if "category" in badge_def else list(category_columns.keys())

        for cat in cats:
            col = category_columns[cat]
            stmt = (
                select(UserMetrics.user_hash)
                .order_by(col.desc())
                .limit(top_n)
            )
            result = await db.execute(stmt)
            top_hashes = [r[0] for r in result.all()]
            if user_hash in top_hashes:
                awarded = await _award_badge(db, user_hash, badge_def["id"])
                if awarded:
                    newly_awarded.append(awarded)
                break

    return newly_awarded


async def evaluate_team_badges(db: AsyncSession, user_hash: str) -> List[str]:
    newly_awarded = []
    user = await db.get(User, user_hash)
    if user and user.team_hash:
        awarded = await _award_badge(db, user_hash, "team_player")
        if awarded:
            newly_awarded.append(awarded)
    return newly_awarded
