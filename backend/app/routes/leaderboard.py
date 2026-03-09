from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, case
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import User, UserMetrics, Team
from app.services.ranking import compute_tier

router = APIRouter(prefix="/api/leaderboard", tags=["leaderboard"])

CATEGORY_COLUMNS = {
    "tokens": UserMetrics.total_tokens,
    "messages": UserMetrics.total_messages + UserMetrics.total_sessions,
    "tools": UserMetrics.total_tool_calls,
    "uniqueness": UserMetrics.prompt_uniqueness_score,
    "weighted": UserMetrics.weighted_score,
    "cost": UserMetrics.estimated_spend,
}


@router.get("/{category}")
async def get_leaderboard(
    category: str,
    scope: str = Query("individual", pattern="^(individual|team)$"),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    if category not in CATEGORY_COLUMNS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid category. Must be one of: {', '.join(CATEGORY_COLUMNS.keys())}",
        )

    col = CATEGORY_COLUMNS[category]

    if scope == "individual":
        stmt = (
            select(
                User.user_hash,
                User.username,
                col.label("value"),
                UserMetrics.weighted_score,
            )
            .join(UserMetrics, User.user_hash == UserMetrics.user_hash)
            .order_by(col.desc())
            .offset(offset)
            .limit(limit)
        )
        result = await db.execute(stmt)
        entries = [
            {
                "rank": offset + i + 1,
                "user_hash": row.user_hash,
                "username": row.username,
                "value": float(row.value) if isinstance(row.value, float) else int(row.value),
                "weighted_score": row.weighted_score,
                "tier": compute_tier(row.weighted_score)["tier"],
            }
            for i, row in enumerate(result.all())
        ]

        count_stmt = select(func.count()).select_from(UserMetrics)
        count_result = await db.execute(count_stmt)
        total = count_result.scalar_one()

        return {
            "category": category,
            "scope": "individual",
            "entries": entries,
            "total_count": total,
        }

    else:  # team
        # Aggregate metrics by team
        stmt = (
            select(
                User.team_hash,
                Team.team_name,
                func.sum(
                    case(
                        (category == "messages",
                         UserMetrics.total_messages + UserMetrics.total_sessions),
                        else_=getattr(UserMetrics, _team_col_name(category)),
                    )
                ).label("value"),
                func.count(User.user_hash).label("member_count"),
            )
            .join(UserMetrics, User.user_hash == UserMetrics.user_hash)
            .join(Team, User.team_hash == Team.team_hash)
            .where(User.team_hash.isnot(None))
            .group_by(User.team_hash, Team.team_name)
            .order_by(func.sum(
                case(
                    (category == "messages",
                     UserMetrics.total_messages + UserMetrics.total_sessions),
                    else_=getattr(UserMetrics, _team_col_name(category)),
                )
            ).desc())
            .offset(offset)
            .limit(limit)
        )
        result = await db.execute(stmt)
        entries = [
            {
                "rank": offset + i + 1,
                "team_hash": row.team_hash,
                "team_name": row.team_name,
                "value": float(row.value) if isinstance(row.value, float) else int(row.value),
                "member_count": row.member_count,
            }
            for i, row in enumerate(result.all())
        ]

        count_stmt = (
            select(func.count(func.distinct(User.team_hash)))
            .where(User.team_hash.isnot(None))
        )
        count_result = await db.execute(count_stmt)
        total = count_result.scalar_one()

        return {
            "category": category,
            "scope": "team",
            "entries": entries,
            "total_count": total,
        }


def _team_col_name(category: str) -> str:
    mapping = {
        "tokens": "total_tokens",
        "messages": "total_messages",
        "tools": "total_tool_calls",
        "uniqueness": "prompt_uniqueness_score",
        "weighted": "weighted_score",
        "cost": "estimated_spend",
    }
    return mapping.get(category, "total_tokens")
