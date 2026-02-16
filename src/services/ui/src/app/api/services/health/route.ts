import { NextResponse } from 'next/server';

const SERVICES = [
  { name: 'API', url: process.env.API_URL || 'http://localhost:3000', path: '/health' },
  { name: 'AI', url: process.env.AI_URL || 'http://localhost:8000', path: '/health' },
  { name: 'Keycloak', url: process.env.KEYCLOAK_INTERNAL_URL || 'http://localhost:8080', path: '/realms/hill90' },
  { name: 'MCP', url: process.env.MCP_URL || 'http://localhost:8001', path: '/health' },
];

async function checkService(service: { name: string; url: string; path: string }) {
  const start = Date.now();
  try {
    const res = await fetch(`${service.url}${service.path}`, {
      signal: AbortSignal.timeout(5000),
    });
    const responseTime = Date.now() - start;
    return {
      name: service.name,
      status: res.ok ? 'healthy' as const : 'unhealthy' as const,
      responseTime,
    };
  } catch (error) {
    const responseTime = Date.now() - start;
    console.error(`[health-check] ${service.name} failed (${responseTime}ms):`, error instanceof Error ? error.message : error);
    return {
      name: service.name,
      status: 'unhealthy' as const,
      responseTime,
    };
  }
}

export async function GET() {
  const results = await Promise.all(SERVICES.map(checkService));
  return NextResponse.json(
    { services: results },
    { headers: { 'Cache-Control': 'public, max-age=10' } },
  );
}
