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
  const url = new URL(`${API_URL}/agents/${pathStr}`)

  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value)
  })

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${session.accessToken}`,
  }

  const contentType = req.headers.get('content-type')
  if (contentType) {
    headers['Content-Type'] = contentType
  }

  const ifNoneMatch = req.headers.get('if-none-match')
  if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch

  const isSSE = req.nextUrl.searchParams.get('follow') === 'true'

  const fetchOpts: RequestInit = {
    method: req.method,
    headers,
    ...(isSSE ? {} : { signal: AbortSignal.timeout(30000) }),
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fetchOpts.body = await req.arrayBuffer()
    ;(fetchOpts as any).duplex = 'half'
  }

  try {
    const res = await fetch(url.toString(), fetchOpts)

    const resContentType = res.headers.get('content-type') || ''
    if (resContentType.includes('text/event-stream')) {
      return new Response(res.body, {
        status: res.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      })
    }

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

    if (res.status === 304) {
      return new Response(null, { status: 304 })
    }

    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    console.error('[agents-proxy] Error:', err)
    return NextResponse.json({ error: 'API request failed' }, { status: 502 })
  }
}

export const GET = proxyRequest
export const POST = proxyRequest
export const PUT = proxyRequest
export const DELETE = proxyRequest
