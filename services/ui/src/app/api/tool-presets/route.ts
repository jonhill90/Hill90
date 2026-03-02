import { NextRequest } from 'next/server'
import { proxyToApi } from '@/utils/api-proxy'

async function proxyRequest(req: NextRequest) {
  return proxyToApi(req, '/tool-presets', { label: 'tool-presets-proxy' })
}

export const GET = proxyRequest
export const POST = proxyRequest
