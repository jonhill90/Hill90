import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockSession: any = null

vi.mock('@/auth', () => ({
  auth: vi.fn(() => Promise.resolve(mockSession)),
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((data: any, init?: { status?: number }) => ({
      _type: 'NextResponse.json',
      _data: data,
      _status: init?.status ?? 200,
    })),
  },
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Import after mocks
const { GET } = await import('@/app/api/docs/openapi/route')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('docs openapi proxy', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    vi.clearAllMocks()
  })

  it('returns 401 when session is null', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = null

    await GET()

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'Not authenticated' },
      { status: 401 }
    )
  })

  it('returns 401 when session has no accessToken', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = { user: { roles: ['admin'] } }

    await GET()

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'Not authenticated' },
      { status: 401 }
    )
  })

  it('returns 403 when user has only user role', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = { accessToken: 'tok', user: { roles: ['user'] } }

    await GET()

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'Forbidden' },
      { status: 403 }
    )
  })

  it('returns 403 when user has no roles', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = { accessToken: 'tok', user: { roles: [] } }

    await GET()

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'Forbidden' },
      { status: 403 }
    )
  })

  it('proxies spec from API for admin', async () => {
    const { NextResponse } = await import('next/server')
    const spec = { openapi: '3.0.0', info: { title: 'Hill90 API' } }
    mockSession = { accessToken: 'admin-jwt', user: { roles: ['admin'] } }
    mockFetch.mockResolvedValue({
      status: 200,
      json: () => Promise.resolve(spec),
    })

    await GET()

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/openapi.json'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer admin-jwt' },
      })
    )
    expect(NextResponse.json).toHaveBeenCalledWith(spec, { status: 200 })
  })

  it('returns 502 when upstream fetch fails', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = { accessToken: 'admin-jwt', user: { roles: ['admin'] } }
    mockFetch.mockRejectedValue(new Error('connection refused'))

    await GET()

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'API request failed' },
      { status: 502 }
    )
  })

  it('returns upstream status for non-200 API response', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = { accessToken: 'admin-jwt', user: { roles: ['admin'] } }
    mockFetch.mockResolvedValue({
      status: 503,
      json: () => Promise.resolve({ error: 'Service Unavailable' }),
    })

    await GET()

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'Service Unavailable' },
      { status: 503 }
    )
  })
})
