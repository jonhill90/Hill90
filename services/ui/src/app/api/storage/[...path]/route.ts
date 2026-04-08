import { NextRequest } from 'next/server'
import { proxyToApi } from '@/utils/api-proxy'
import { proxyMultipartToApi } from '@/utils/api-proxy-multipart'

async function proxyRequest(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  const pathStr = path.join('/')
  return proxyToApi(req, `/storage/${pathStr}`, { label: 'storage-proxy' })
}

async function proxyUpload(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  const pathStr = path.join('/')
  return proxyMultipartToApi(req, `/storage/${pathStr}`, { label: 'storage-proxy-upload' })
}

export const GET = proxyRequest
export const POST = proxyUpload
export const DELETE = proxyRequest
