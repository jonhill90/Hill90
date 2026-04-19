import { NextRequest } from 'next/server'
import { proxyToApi } from '@/utils/api-proxy'

async function proxyRequest(req: NextRequest) {
  return proxyToApi(req, '/workflows', { label: 'workflows-proxy' })
}

export const GET = proxyRequest
export const POST = proxyRequest
