import { NextRequest } from 'next/server'
import { proxyToApi } from '@/utils/api-proxy'

async function proxyRequest(req: NextRequest) {
  return proxyToApi(req, '/admin/secrets/kv', { label: 'secrets-kv-proxy' })
}

export const PUT = proxyRequest
export const DELETE = proxyRequest
