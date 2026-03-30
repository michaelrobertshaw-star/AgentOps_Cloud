# AgentOps Cloud v2

Multi-tenant AI Operations Platform where AI agents operate as digital workers inside organizational departments.

## Prerequisites

- Node.js >= 20
- pnpm >= 9
- Docker & Docker Compose

## Quick Start

```bash
# Install dependencies
pnpm install

# Start local infrastructure (Postgres + Redis)
docker compose up -d

# Run database migrations
pnpm db:migrate

# Start development servers
pnpm dev
```

The API server runs at `http://localhost:4000`.

## Project Structure

```
agentops-cloud/
  apps/
    server/          # API server (Express)
  packages/
    shared/          # Shared types and utilities
    db/              # Database schema and migrations (Drizzle ORM + Postgres)
```

## Scripts

| Command              | Description                              |
| -------------------- | ---------------------------------------- |
| `pnpm build`         | Build all packages                       |
| `pnpm dev`           | Start all services in dev/watch mode     |
| `pnpm lint`          | Run ESLint                               |
| `pnpm lint:fix`      | Run ESLint with auto-fix                 |
| `pnpm format`        | Format code with Prettier                |
| `pnpm format:check`  | Check formatting                         |
| `pnpm typecheck`     | Type-check all packages                  |
| `pnpm test`          | Run tests (Vitest)                       |
| `pnpm test:watch`    | Run tests in watch mode                  |
| `pnpm db:generate`   | Generate Drizzle migration files         |
| `pnpm db:migrate`    | Apply database migrations                |
| `pnpm db:studio`     | Open Drizzle Studio (DB browser)         |

## Environment Variables

Copy `.env.example` to `.env` and adjust values:

```bash
cp .env.example .env
```

| Variable       | Default                                                  | Description              |
| -------------- | -------------------------------------------------------- | ------------------------ |
| `DATABASE_URL` | `postgresql://agentops:agentops@localhost:5432/agentops` | Postgres connection URL  |
| `REDIS_URL`    | `redis://localhost:6379`                                 | Redis connection URL     |
| `PORT`         | `4000`                                                   | API server port          |
| `HOST`         | `0.0.0.0`                                                | API server bind host     |
| `NODE_ENV`     | `development`                                            | Environment              |

## CI/CD

GitHub Actions runs on every PR and push to `main`:
- Lint + format check + type check
- Tests with a real Postgres instance
