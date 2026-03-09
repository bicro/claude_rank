from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.services.hotness import get_hot_users
from app.services.ranking import compute_tier

router = APIRouter(prefix="/api", tags=["hot"])


@router.get("/hot")
async def hot_users(
    limit: int = Query(20, ge=1, le=50),
    days: int = Query(3, ge=1, le=30),
    db: AsyncSession = Depends(get_db),
):
    users = await get_hot_users(db, limit=limit, lookback_days=days)
    for u in users:
        u["tier"] = compute_tier(u["weighted_score"])
    return {"users": users}
