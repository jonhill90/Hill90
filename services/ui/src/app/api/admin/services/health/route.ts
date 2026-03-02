import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { ADMIN_SERVICES } from '@/utils/admin-services'

async function checkService(service: { name: string; internalUrl: string; path: string }) {
  const start = Date.now()
  try {
    const res = await fetch(`${service.internalUrl}${service.path}`, {
      signal: AbortSignal.timeout(5000),
    })
    const responseTime = Date.now() - start
    return {
      name: service.name,
      status: res.ok ? 'healthy' as const : 'unhealthy' as const,
      responseTime,
    }
  } catch {
    const responseTime = Date.now() - start
    return {
      name: service.name,
      status: 'unhealthy' as const,
      responseTime,
    }
  }
}

export async function GET() {
  const session = await auth()

  if (!(session as any)?.accessToken) {
    return NextResponse.json(
      { error: 'Not authenticated' },
      { status: 401 },
    )
  }

  if (!(session as any)?.user?.roles?.includes('admin')) {
    return NextResponse.json(
      { error: 'Forbidden' },
      { status: 403 },
    )
  }

  const probes = ADMIN_SERVICES
    .filter((svc) => svc.healthCheck)
    .map((svc) => checkService({
      name: svc.name,
      internalUrl: svc.healthCheck!.internalUrl,
      path: svc.healthCheck!.path,
    }))

  const results = await Promise.all(probes)

  return NextResponse.json(
    { services: results },
    {
      status: 200,
      headers: { 'Cache-Control': 'private, max-age=10' },
    },
  )
}
