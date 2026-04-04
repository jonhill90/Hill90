import { NextRequest } from 'next/server'
import { proxyToApi } from '@/utils/api-proxy'

async function proxyRequest(req: NextRequest) {
  return proxyToApi(req, '/admin/secrets/status', { label: 'secrets-status-proxy' })
}

export const GET = proxyRequest
