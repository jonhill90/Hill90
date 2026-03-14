import { NextRequest } from 'next/server'
import { proxyToApi } from '@/utils/api-proxy'

async function proxyRequest(req: NextRequest) {
  return proxyToApi(req, '/container-profiles', { label: 'container-profiles-proxy' })
}

export const GET = proxyRequest
