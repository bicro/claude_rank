# Claude Rank

A global leaderboard system for tracking Claude API usage. Compete with other Claude users, earn badges, join teams, and climb the ranks.

**Website**: [clauderank.com](https://clauderank.com)

## Features

- **Global Leaderboards**: Compete across 6 ranking categories
  - Token Usage
  - Messages & Sessions
  - Tool Calls
  - Prompt Uniqueness
  - Weighted Score (composite)
  - Estimated Spend

- **User Profiles**: View detailed stats including usage heatmaps, badges, and tier progression

- **Badge System**: Earn achievements for milestones and ranking positions
  - Milestone badges (Token Millionaire, Tool Master, etc.)
  - Ranking badges (Top 100, Top 10, #1)
  - Team badges

- **Team Competition**: Create or join teams to compete with aggregated metrics

- **Tier Progression**: Advance through Bronze, Silver, Gold, Platinum, and Diamond tiers

## Project Structure

```
claude_rank/
├── backend/          # FastAPI backend (Python)
├── desktop/          # Tauri desktop app
├── website/          # Static website (HTML/JS/CSS)
└── src-tauri/        # Shared Tauri/Rust code
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | FastAPI, SQLAlchemy, PostgreSQL |
| Desktop | Tauri 2.x, Rust, TypeScript |
| Website | Vanilla HTML/JS/CSS |

## Development

### Prerequisites

- [Bun](https://bun.sh/)
- [Rust](https://rustup.rs/)
- [Python 3.11+](https://python.org/)

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### Desktop App

```bash
cd desktop
bun install
bun run dev
```

### Website

The website is served statically by the backend. For local development, it's mounted at `/` when running the backend.

## API

The backend exposes a REST API at `/api`:

| Endpoint | Description |
|----------|-------------|
| `GET /api/users/{hash}` | Get user profile |
| `POST /api/sync` | Sync usage metrics |
| `GET /api/leaderboard/{category}` | Get leaderboard rankings |
| `GET /api/teams/{id}` | Get team details |
| `GET /api/hot` | Get trending users |

## Environment Variables

Create a `.env` file in the backend directory:

```
DATABASE_URL=postgresql://...  # or sqlite:///./local.db for development
```

## Deployment

- **Backend**: Deployed on [Render](https://render.com)
- **Website**: Served by the backend as static files

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
