import { NextRequest } from 'next/server'
import { proxyToApi } from '@/utils/api-proxy'

async function proxyRequest(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  const pathStr = path.join('/')

  // Chat stream is always SSE — disable timeout
  const isStream = pathStr.endsWith('/stream')

  return proxyToApi(req, `/chat/threads/${pathStr}`, {
    label: 'chat-proxy',
    ...(isStream ? { sse: true } : {}),
  })
}

export const GET = proxyRequest
export const POST = proxyRequest
export const PUT = proxyRequest
export const DELETE = proxyRequest
