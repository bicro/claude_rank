from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Badge

router = APIRouter(prefix="/api/badges", tags=["badges"])


@router.get("")
async def get_all_badges(db: AsyncSession = Depends(get_db)):
    stmt = select(Badge).order_by(Badge.category, Badge.id)
    result = await db.execute(stmt)
    badges = result.scalars().all()
    return [
        {
            "id": b.id,
            "name": b.name,
            "description": b.description,
            "category": b.category,
            "icon": b.icon,
        }
        for b in badges
    ]
