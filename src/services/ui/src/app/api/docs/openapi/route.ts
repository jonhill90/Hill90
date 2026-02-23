import { auth } from '@/auth'
import { NextResponse } from 'next/server'

const API_URL = process.env.API_URL || 'http://localhost:3000'

export async function GET() {
  const session = await auth()
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  if (!session.user?.roles?.includes('admin')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const res = await fetch(`${API_URL}/openapi.json`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    console.error('[docs-proxy] Error:', err)
    return NextResponse.json({ error: 'API request failed' }, { status: 502 })
  }
}
