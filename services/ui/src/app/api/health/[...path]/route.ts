import { NextRequest } from 'next/server'
import { proxyToApi } from '@/utils/api-proxy'

async function proxyRequest(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  const pathStr = path.join('/')
  return proxyToApi(req, `/health/${pathStr}`, { label: 'health-proxy' })
}

export const GET = proxyRequest
