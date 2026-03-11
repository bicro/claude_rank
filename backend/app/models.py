from __future__ import annotations
from datetime import datetime, date
from typing import Optional, List
from sqlalchemy import (
    String, BigInteger, Float, DateTime, Date, Text, ForeignKey, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db import Base


class User(Base):
    __tablename__ = "users"

    user_hash: Mapped[str] = mapped_column(String(36), primary_key=True)
    username: Mapped[Optional[str]] = mapped_column(String(20), unique=True, nullable=True)
    team_hash: Mapped[Optional[str]] = mapped_column(
        String(8), ForeignKey("teams.team_hash"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    metrics: Mapped[Optional["UserMetrics"]] = relationship(back_populates="user", uselist=False)
    badges: Mapped[List["UserBadge"]] = relationship(back_populates="user")
    team: Mapped[Optional["Team"]] = relationship(back_populates="members", foreign_keys=[team_hash])


class Team(Base):
    __tablename__ = "teams"

    team_hash: Mapped[str] = mapped_column(String(8), primary_key=True)
    team_name: Mapped[str] = mapped_column(String(30), nullable=False)
    created_by: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_hash"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    members: Mapped[List["User"]] = relationship(
        back_populates="team", foreign_keys=[User.team_hash]
    )


class UserMetrics(Base):
    __tablename__ = "user_metrics"

    user_hash: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.user_hash"), primary_key=True
    )
    total_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    total_messages: Mapped[int] = mapped_column(BigInteger, default=0)
    total_sessions: Mapped[int] = mapped_column(BigInteger, default=0)
    total_tool_calls: Mapped[int] = mapped_column(BigInteger, default=0)
    prompt_uniqueness_score: Mapped[float] = mapped_column(Float, default=0.0)
    weighted_score: Mapped[float] = mapped_column(Float, default=0.0)
    current_streak: Mapped[int] = mapped_column(BigInteger, default=0)
    total_points: Mapped[int] = mapped_column(BigInteger, default=0)
    level: Mapped[int] = mapped_column(BigInteger, default=0)
    estimated_spend: Mapped[float] = mapped_column(Float, default=0.0)
    last_synced: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    # Session duration tracking
    total_session_time_secs: Mapped[int] = mapped_column(BigInteger, default=0)
    total_active_time_secs: Mapped[int] = mapped_column(BigInteger, default=0)
    total_idle_time_secs: Mapped[int] = mapped_column(BigInteger, default=0)

    user: Mapped["User"] = relationship(back_populates="metrics")


class MetricsHistory(Base):
    __tablename__ = "metrics_history"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_hash: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_hash"))
    snapshot_date: Mapped[date] = mapped_column(Date, nullable=False)
    total_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    total_messages: Mapped[int] = mapped_column(BigInteger, default=0)
    total_sessions: Mapped[int] = mapped_column(BigInteger, default=0)
    total_tool_calls: Mapped[int] = mapped_column(BigInteger, default=0)
    prompt_uniqueness_score: Mapped[float] = mapped_column(Float, default=0.0)
    weighted_score: Mapped[float] = mapped_column(Float, default=0.0)
    daily_messages: Mapped[int] = mapped_column(BigInteger, default=0)
    daily_tool_calls: Mapped[int] = mapped_column(BigInteger, default=0)

    __table_args__ = (UniqueConstraint("user_hash", "snapshot_date"),)


class MetricsHourly(Base):
    __tablename__ = "metrics_hourly"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_hash: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_hash"))
    snapshot_hour: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    total_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    total_messages: Mapped[int] = mapped_column(BigInteger, default=0)
    total_sessions: Mapped[int] = mapped_column(BigInteger, default=0)
    total_tool_calls: Mapped[int] = mapped_column(BigInteger, default=0)
    prompt_uniqueness_score: Mapped[float] = mapped_column(Float, default=0.0)
    weighted_score: Mapped[float] = mapped_column(Float, default=0.0)

    __table_args__ = (UniqueConstraint("user_hash", "snapshot_hour"),)


class Badge(Base):
    __tablename__ = "badges"

    id: Mapped[str] = mapped_column(String(30), primary_key=True)
    name: Mapped[str] = mapped_column(String(50), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(String(20), nullable=False)
    icon: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)


class UserBadge(Base):
    __tablename__ = "user_badges"

    user_hash: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.user_hash"), primary_key=True
    )
    badge_id: Mapped[str] = mapped_column(
        String(30), ForeignKey("badges.id"), primary_key=True
    )
    unlocked_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user: Mapped["User"] = relationship(back_populates="badges")
    badge: Mapped["Badge"] = relationship()


class ConcurrencyHistogram(Base):
    __tablename__ = "concurrency_histogram"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_hash: Mapped[str] = mapped_column(String(36), ForeignKey("users.user_hash"))
    snapshot_hour: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    histogram: Mapped[str] = mapped_column(Text)  # JSON: {"1": 20, "2": 30}

    __table_args__ = (UniqueConstraint("user_hash", "snapshot_hour"),)
