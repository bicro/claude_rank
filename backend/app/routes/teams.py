import secrets
import string
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import User, Team, UserMetrics, MetricsHistory

router = APIRouter(prefix="/api/teams", tags=["teams"])


def generate_team_hash() -> str:
    chars = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(8))


class CreateTeamRequest(BaseModel):
    user_hash: str
    team_name: str


class JoinTeamRequest(BaseModel):
    user_hash: str


class LeaveTeamRequest(BaseModel):
    user_hash: str


@router.post("")
async def create_team(req: CreateTeamRequest, db: AsyncSession = Depends(get_db)):
    user = await db.get(User, req.user_hash)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.team_hash:
        raise HTTPException(status_code=400, detail="Already in a team. Leave first.")

    team_name = req.team_name.strip()
    if not team_name or len(team_name) > 30:
        raise HTTPException(status_code=400, detail="Team name must be 1-30 characters")

    team_hash = generate_team_hash()
    team = Team(
        team_hash=team_hash,
        team_name=team_name,
        created_by=req.user_hash,
        created_at=datetime.utcnow(),
    )
    db.add(team)

    user.team_hash = team_hash
    user.updated_at = datetime.utcnow()
    await db.commit()

    return {"team_hash": team_hash, "team_name": team_name}


@router.post("/{team_hash}/join")
async def join_team(team_hash: str, req: JoinTeamRequest, db: AsyncSession = Depends(get_db)):
    user = await db.get(User, req.user_hash)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.team_hash:
        raise HTTPException(status_code=400, detail="Already in a team. Leave first.")

    team = await db.get(Team, team_hash)
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")

    user.team_hash = team_hash
    user.updated_at = datetime.utcnow()
    await db.commit()

    return {"status": "joined", "team_hash": team_hash, "team_name": team.team_name}


@router.post("/leave")
async def leave_team(req: LeaveTeamRequest, db: AsyncSession = Depends(get_db)):
    user = await db.get(User, req.user_hash)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not user.team_hash:
        raise HTTPException(status_code=400, detail="Not in a team")

    user.team_hash = None
    user.updated_at = datetime.utcnow()
    await db.commit()

    return {"status": "left"}


@router.get("/{team_hash}")
async def get_team(team_hash: str, db: AsyncSession = Depends(get_db)):
    team = await db.get(Team, team_hash)
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")

    # Get members
    stmt = select(User).where(User.team_hash == team_hash)
    result = await db.execute(stmt)
    members = result.scalars().all()

    # Aggregate team metrics
    member_hashes = [m.user_hash for m in members]
    agg_stmt = select(
        func.coalesce(func.sum(UserMetrics.total_tokens), 0),
        func.coalesce(func.sum(UserMetrics.total_messages), 0),
        func.coalesce(func.sum(UserMetrics.total_sessions), 0),
        func.coalesce(func.sum(UserMetrics.total_tool_calls), 0),
    ).where(UserMetrics.user_hash.in_(member_hashes))
    agg_result = await db.execute(agg_stmt)
    agg = agg_result.one()

    return {
        "team_hash": team.team_hash,
        "team_name": team.team_name,
        "created_by": team.created_by,
        "created_at": team.created_at.isoformat(),
        "member_count": len(members),
        "members": [
            {"user_hash": m.user_hash, "username": m.username}
            for m in members
        ],
        "metrics": {
            "total_tokens": int(agg[0]),
            "total_messages": int(agg[1]),
            "total_sessions": int(agg[2]),
            "total_tool_calls": int(agg[3]),
        },
    }


@router.get("/{team_hash}/history")
async def get_team_history(team_hash: str, days: int = 30, db: AsyncSession = Depends(get_db)):
    # Get member hashes
    stmt = select(User.user_hash).where(User.team_hash == team_hash)
    result = await db.execute(stmt)
    member_hashes = [r[0] for r in result.all()]
    if not member_hashes:
        return []

    hist_stmt = (
        select(
            MetricsHistory.snapshot_date,
            func.sum(MetricsHistory.total_tokens),
            func.sum(MetricsHistory.total_messages),
            func.sum(MetricsHistory.total_sessions),
            func.sum(MetricsHistory.total_tool_calls),
        )
        .where(MetricsHistory.user_hash.in_(member_hashes))
        .group_by(MetricsHistory.snapshot_date)
        .order_by(MetricsHistory.snapshot_date.desc())
        .limit(days)
    )
    hist_result = await db.execute(hist_stmt)
    return [
        {
            "date": row[0].isoformat(),
            "tokens": int(row[1]),
            "messages": int(row[2]),
            "sessions": int(row[3]),
            "tool_calls": int(row[4]),
        }
        for row in hist_result.all()
    ]
