import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { proxyToApi } from '@/utils/api-proxy'

const API_URL = process.env.API_URL || 'http://localhost:3000'

async function proxyRequest(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  const pathStr = path.join('/')
  return proxyToApi(req, `/storage/${pathStr}`, { label: 'storage-proxy' })
}

async function proxyUpload(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const session = await auth()
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { path } = await params
  const pathStr = path.join('/')
  const url = new URL(`${API_URL}/storage/${pathStr}`)
  const contentType = req.headers.get('content-type') || ''

  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.accessToken}`,
        'Content-Type': contentType,
      },
      body: await req.arrayBuffer(),
      signal: AbortSignal.timeout(60000),
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    console.error('[storage-proxy-upload] Error:', err)
    return NextResponse.json({ error: 'API request failed' }, { status: 502 })
  }
}

export const GET = proxyRequest
export const POST = proxyUpload
export const DELETE = proxyRequest
