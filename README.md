# StepShare Backend

NestJS + TypeScript + PostgreSQL REST API.

## Setup

```bash
# Install dependencies
npm install

# Create PostgreSQL database
createdb stepshare

# Copy and edit environment variables
cp .env.example .env

# Start in development mode
npm run start:dev
```

## API Endpoints

### Auth
- `POST /auth/register` — `{ name, email, password }` → `{ token, user }`
- `POST /auth/login` — `{ email, password }` → `{ token, user }`

### Connections (JWT required)
- `POST /connections` — `{ connectionCode }` → connection object (idempotent)
- `GET /connections` → list of active connections

### Steps (JWT required)
- `PUT /steps/sync` — `{ stepCount, date }` → upsert daily record (idempotent)
- `GET /steps/me?date=YYYY-MM-DD` → own steps
- `GET /steps/user/:userId?date=YYYY-MM-DD` → peer steps (requires active connection + sharing enabled)

## Idempotency

- **Registration**: unique constraint on email prevents duplicates.
- **Connections**: unique constraint on (user_a, user_b); re-submitting same code returns existing connection.
- **Step sync**: UPSERT on (user_id, date). Client sends TOTAL count, not deltas. Monotonic — server ignores counts lower than stored value.

## Authorization

User B can only view User A's steps if:
1. B is authenticated (valid JWT)
2. A and B have an active connection
3. A has `sharingEnabled = true`
