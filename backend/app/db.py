import os
from dotenv import load_dotenv
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "")

if DATABASE_URL:
    # Render provides DATABASE_URL with postgres:// scheme; SQLAlchemy needs postgresql+asyncpg://
    if DATABASE_URL.startswith("postgres://"):
        DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)
    elif DATABASE_URL.startswith("postgresql://"):
        DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)
else:
    # Local dev: use SQLite
    DATABASE_URL = "sqlite+aiosqlite:///./clauderank.db"

engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with async_session() as session:
        yield session


IS_SQLITE = DATABASE_URL.startswith("sqlite")


async def init_db():
    import logging
    log = logging.getLogger(__name__)

    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    except Exception as e:
        # Multiple Gunicorn workers may race to create tables simultaneously.
        # If another worker already created them, ignore the duplicate error.
        log.warning(f"init_db ignoring (likely race condition): {e}")

    # Add columns that create_all can't add to existing tables
    migrations = [
        ("user_metrics", "current_streak", "BIGINT DEFAULT 0"),
        ("user_metrics", "total_points", "BIGINT DEFAULT 0"),
        ("user_metrics", "level", "BIGINT DEFAULT 0"),
        ("metrics_history", "daily_messages", "BIGINT DEFAULT 0"),
        ("metrics_history", "daily_tool_calls", "BIGINT DEFAULT 0"),
        ("user_metrics", "estimated_spend", "DOUBLE PRECISION DEFAULT 0"),
    ]
    try:
        async with engine.begin() as conn:
            for table, column, col_type in migrations:
                if IS_SQLITE:
                    # SQLite doesn't support IF NOT EXISTS on ADD COLUMN;
                    # check information_schema equivalent
                    result = await conn.execute(
                        text(
                            f"PRAGMA table_info({table})"
                        )
                    )
                    existing = [row[1] for row in result.fetchall()]
                    if column not in existing:
                        await conn.execute(
                            text(
                                f"ALTER TABLE {table} ADD COLUMN {column} {col_type}"
                            )
                        )
                        log.info(f"Added column {table}.{column}")
                else:
                    await conn.execute(
                        text(
                            f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {col_type}"
                        )
                    )
                    log.info(f"Ensured column {table}.{column} exists")
    except Exception as e:
        log.warning(f"Column migration warning: {e}")
