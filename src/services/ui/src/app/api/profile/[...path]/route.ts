import { auth } from '@/auth'
import { NextRequest, NextResponse } from 'next/server'

const API_URL = process.env.API_URL || 'http://localhost:3000'

async function proxyRequest(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const session = await auth()
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { path } = await params
  const pathStr = path.join('/')
  const url = new URL(`${API_URL}/profile/${pathStr}`)

  // Forward query params
  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value)
  })

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${session.accessToken}`,
  }

  const contentType = req.headers.get('content-type')

  // For multipart (avatar upload), forward raw body and content-type header
  // For JSON requests, forward content-type normally
  if (contentType) {
    headers['Content-Type'] = contentType
  }

  const fetchOpts: RequestInit = {
    method: req.method,
    headers,
    signal: AbortSignal.timeout(30000),
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // Forward raw body bytes (works for both multipart and JSON)
    fetchOpts.body = await req.arrayBuffer()
    // duplex required for streaming request bodies in Node fetch
    ;(fetchOpts as any).duplex = 'half'
  }

  try {
    const res = await fetch(url.toString(), fetchOpts)

    // Binary response (avatar image) — stream through
    const resContentType = res.headers.get('content-type') || ''
    if (resContentType.startsWith('image/')) {
      const responseHeaders: Record<string, string> = {
        'Content-Type': resContentType,
        'Cache-Control': res.headers.get('cache-control') || 'private, no-cache',
      }
      const etag = res.headers.get('etag')
      if (etag) responseHeaders['ETag'] = etag

      return new Response(res.body, {
        status: res.status,
        headers: responseHeaders,
      })
    }

    // 304 Not Modified has no body
    if (res.status === 304) {
      return new Response(null, { status: 304 })
    }

    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    console.error('[profile-proxy] Error:', err)
    return NextResponse.json({ error: 'API request failed' }, { status: 502 })
  }
}

export const GET = proxyRequest
export const POST = proxyRequest
export const DELETE = proxyRequest
