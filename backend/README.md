# Srujana Hackathon Backend

Node.js 20+ · Express 5 · PostgreSQL · Prisma · JWT

## Included

- Email/password registration and login with bcrypt password hashing
- Signed JWT access tokens and `/api/auth/me`
- PostgreSQL models for users and user-owned projects
- Project CRUD with owner isolation and pagination
- Optional OpenAI-compatible chat completions integration
- Zod request validation, Helmet, CORS allowlist, rate limits, JSON error responses
- Health endpoint, basic API tests, Dockerfile and PostgreSQL Compose service

> The `Project` resource is a working example until the actual Srujana frontend/domain model is connected. Replace it with the real project entities after inspecting the frontend.

## Requirements

- Node.js 20 or newer
- Docker Desktop / Docker Engine (recommended) or a PostgreSQL database

## Local setup

1. Copy `.env.example` to `.env`.
2. Set `JWT_SECRET` to a unique random value of at least 32 characters.
3. Start PostgreSQL: `docker compose up -d db`
4. Install dependencies: `npm install`
5. Generate Prisma client: `npm run db:generate`
6. Create/apply local migration: `npm run db:migrate`
7. Start server: `npm run dev`

API defaults to `http://localhost:4000`.

## Endpoints

| Method | Endpoint | Auth | Purpose |
|---|---|---:|---|
| GET | `/api/health` | No | Health check |
| POST | `/api/auth/register` | No | Create account |
| POST | `/api/auth/login` | No | Login |
| GET | `/api/auth/me` | Yes | Current profile |
| GET | `/api/projects?page=1&limit=20` | Yes | List own projects |
| POST | `/api/projects` | Yes | Create project |
| GET | `/api/projects/:id` | Yes | Read own project |
| PATCH | `/api/projects/:id` | Yes | Update own project |
| DELETE | `/api/projects/:id` | Yes | Delete own project |
| POST | `/api/ai/generate` | Yes | Optional AI completion |

## Example requests

Register:
```bash
curl -X POST http://localhost:4000/api/auth/register \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"Demo User","email":"demo@example.com","password":"a-strong-password-123"}'
```

Login:
```bash
curl -X POST http://localhost:4000/api/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"demo@example.com","password":"a-strong-password-123"}'
```

Use the returned token:
```bash
curl http://localhost:4000/api/projects \\
  -H 'Authorization: Bearer YOUR_TOKEN'
```

Create project:
```bash
curl -X POST http://localhost:4000/api/projects \\
  -H 'Authorization: Bearer YOUR_TOKEN' \\
  -H 'Content-Type: application/json' \\
  -d '{"title":"My demo project","description":"First record"}'
```

## Tests

Run `npm test`. Tests cover health, 404 handling, and authentication rejection. Database-backed integration tests for signup/login/CRUD should be added against a dedicated test database before deployment.

## AI setup

Set `AI_API_KEY`, `AI_MODEL`, and optionally `AI_BASE_URL` in `.env`. The provider key remains server-side. AI endpoint returns `503 AI_NOT_CONFIGURED` when not configured.

## Deployment checklist

- Use managed PostgreSQL and a strong unique `JWT_SECRET`.
- Set `NODE_ENV=production`, `DATABASE_URL`, and exact frontend origins in `CORS_ORIGINS`.
- Run `npm run db:deploy` during release (or use the included container command).
- Configure HTTPS at the hosting platform / reverse proxy.
- Never commit `.env`; rotate any exposed secrets.
- Consider refresh-token rotation, email verification, password reset, audit logging, and observability before a public production launch.
