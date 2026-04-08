import { auth } from '@/auth'
import { NextRequest, NextResponse } from 'next/server'

const API_URL = process.env.API_URL || 'http://localhost:3000'

/**
 * Proxy a multipart/form-data request to the backend API service.
 * Passes the raw body and content-type (with boundary) through unchanged.
 */
export async function proxyMultipartToApi(
  req: NextRequest,
  backendPath: string,
  { label = 'proxy-multipart' }: { label?: string } = {}
) {
  const session = await auth()
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const url = new URL(`${API_URL}${backendPath}`)

  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value)
  })

  const contentType = req.headers.get('content-type') || ''

  try {
    const res = await fetch(url.toString(), {
      method: req.method,
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
    console.error(`[${label}] Error:`, err)
    return NextResponse.json({ error: 'API request failed' }, { status: 502 })
  }
}
