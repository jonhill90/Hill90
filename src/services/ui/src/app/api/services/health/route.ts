import { NextResponse } from 'next/server';

const SERVICES = [
  { name: 'API', url: process.env.API_URL || 'http://localhost:3000', path: '/health' },
  { name: 'AI', url: process.env.AI_URL || 'http://localhost:8000', path: '/health' },
  { name: 'Auth', url: process.env.AUTH_URL || 'http://localhost:3001', path: '/health' },
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
  } catch {
    return {
      name: service.name,
      status: 'unhealthy' as const,
      responseTime: Date.now() - start,
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
