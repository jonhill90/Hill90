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
- Keycloak: http://localhost:8080 (when running locally)
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

### Keycloak (Identity Provider)

Keycloak runs as a Docker container — no local build needed:
```bash
make deploy-db   # Start PostgreSQL first
make deploy-auth # Start Keycloak
```

Admin console: http://localhost:8080/admin/master/console/

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
