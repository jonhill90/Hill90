# Local Development Setup

Guide for setting up Hill90 for local development.

## Prerequisites

- Docker Desktop
- Node.js 20+
- Python 3.12+
- Poetry

## Quick Start

### 1. Clone Repository

```bash
git clone <repository-url>
cd Hill90
```

### 2. Start Development Environment

```bash
make dev
```

This starts all services in development mode with hot reload.

### 3. Access Services

- API: http://localhost:3000
- AI: http://localhost:8000
- Auth: http://localhost:3001
- PostgreSQL: localhost:5432

## Service Development

### API Service (TypeScript)

```bash
cd src/services/api
npm install
npm run dev
```

### AI Service (Python)

```bash
cd src/services/ai
poetry install
poetry run uvicorn app.main:app --reload
```

### Auth Service (TypeScript)

```bash
cd src/services/auth
npm install
npm run dev
```

## Testing

```bash
make test
```

## Code Quality

```bash
make lint
make format
```

## Troubleshooting

### Port Already in Use

Stop conflicting services or change port in docker-compose.

### Database Connection Failed

Ensure PostgreSQL container is running:
```bash
docker ps | grep postgres-dev
```
