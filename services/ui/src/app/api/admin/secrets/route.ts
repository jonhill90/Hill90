import { NextRequest } from 'next/server'
import { proxyToApi } from '@/utils/api-proxy'

async function proxyRequest(req: NextRequest) {
  return proxyToApi(req, '/admin/secrets', { label: 'secrets-proxy' })
}

export const GET = proxyRequest
