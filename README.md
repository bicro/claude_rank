<p align="center">
  <img src="assets/banner.png" alt="Claude Rank" width="600" />
</p>

<p align="center">
  <strong>A global leaderboard for tracking Claude Code usage.</strong><br/>
  Compete with other Claude users, earn badges, join teams, and climb the ranks.
</p>

<p align="center">
  <a href="https://clauderank.com">Website</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="#development">Development</a> &middot;
  <a href="#api">API</a>
</p>

---

## Demo

https://github.com/user-attachments/assets/demo.mp4

<video src="assets/demo.mp4" width="100%" controls></video>

## Features

- **Global Leaderboards** — Compete across 6 ranking categories
  - Token Usage
  - Messages & Sessions
  - Tool Calls
  - Prompt Uniqueness
  - Weighted Score (composite)
  - Estimated Spend

- **User Profiles** — View detailed stats including usage heatmaps, badges, and tier progression

- **Badge System** — Earn achievements for milestones and ranking positions
  - Milestone badges (Token Millionaire, Tool Master, etc.)
  - Ranking badges (Top 100, Top 10, #1)
  - Team badges

- **Team Competition** — Create or join teams to compete with aggregated metrics

- **Tier Progression** — Advance through Bronze, Silver, Gold, Platinum, and Diamond tiers

- **Desktop App** — Tauri-based app that monitors your Claude Code logs in real-time, syncs metrics, and displays a tray widget with your stats

## Project Structure

```
claude_rank/
├── server/           # Bun.js backend (TypeScript)
├── desktop/          # Tauri 2.x desktop app (Rust + TypeScript)
├── website/          # Static website (HTML/JS/CSS)
├── lib/              # Shared utilities
├── dev.ts            # Dev script (starts server + desktop)
└── Dockerfile        # Production container
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Bun, TypeScript, PostgreSQL |
| Auth | Better Auth (Google, GitHub, Discord, Twitter, LinkedIn) |
| Desktop | Tauri 2.x, Rust |
| Website | Vanilla HTML/JS/CSS |

## Development

### Prerequisites

- [Bun](https://bun.sh/)
- [Rust](https://rustup.rs/) (for the desktop app)

### Full Stack (Server + Desktop)

```bash
bun run dev.ts
```

### Server Only

```bash
cd server
bun run dev
```

### Desktop App Only

```bash
cd desktop
bun install
bun run dev
```

### Website

The website is served statically by the server at `/`.

## API

The server exposes a REST API at `/api`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/users` | POST | Register a new user |
| `/api/users/{hash}` | GET | Get user profile & metrics |
| `/api/users/{hash}/badges` | GET | Get user's badges |
| `/api/users/{hash}/history` | GET | Get metric history |
| `/api/users/{hash}/heatmap` | GET | Get hourly usage heatmap |
| `/api/users/{hash}/daily-ranks` | GET | Get daily rank snapshots |
| `/api/users/by-username/{username}` | GET | Lookup user by username |
| `/api/users/{hash}/connect` | POST | Connect OAuth account |
| `/api/sync` | POST | Sync usage metrics |
| `/api/leaderboard/{category}` | GET | Get leaderboard rankings |
| `/api/teams` | POST | Create a team |
| `/api/teams/{hash}` | GET | Get team details |
| `/api/teams/{hash}/join` | POST | Join a team |
| `/api/teams/{hash}/history` | GET | Get team metric history |
| `/api/teams/leave` | POST | Leave current team |
| `/api/badges` | GET | Get all badge definitions |
| `/api/hot` | GET | Get trending users |
| `/api/auth/*` | * | Better Auth OAuth routes |

## Environment Variables

Copy `.env.example` to `.env.local` and fill in the values:

```bash
cp .env.example .env.local
```

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | Yes | Auth secret (`openssl rand -base64 32`) |
| `BETTER_AUTH_URL` | Yes | Server URL (e.g. `http://localhost:3001`) |
| `WIDGET_BASE` | Yes | Widget base URL |
| `RANKING_API_BASE` | Yes | API base URL |
| `GOOGLE_CLIENT_ID` / `_SECRET` | No | Google OAuth credentials |
| `GITHUB_CLIENT_ID` / `_SECRET` | No | GitHub OAuth credentials |
| `DISCORD_CLIENT_ID` / `_SECRET` | No | Discord OAuth credentials |
| `TWITTER_CLIENT_ID` / `_SECRET` | No | Twitter/X OAuth credentials |
| `LINKEDIN_CLIENT_ID` / `_SECRET` | No | LinkedIn OAuth credentials |

## Deployment

The server is containerized with Docker and deployed on [Render](https://render.com).

```bash
docker build -t claude-rank .
docker run -p 10000:10000 claude-rank
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
