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

  // Forward query params
  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value)
  })

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${session.accessToken}`,
  }

  // Forward content-type for POST/PUT
  const contentType = req.headers.get('content-type')
  if (contentType) {
    headers['Content-Type'] = contentType
  }

  // follow=true is reserved for SSE streaming routes — no timeout for long-lived streams
  const isSSE = req.nextUrl.searchParams.get('follow') === 'true'

  const fetchOpts: RequestInit = {
    method: req.method,
    headers,
    ...(isSSE ? {} : { signal: AbortSignal.timeout(30000) }),
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fetchOpts.body = await req.text()
  }

  try {
    const res = await fetch(url.toString(), fetchOpts)

    // SSE: pass the stream through without JSON parsing
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
