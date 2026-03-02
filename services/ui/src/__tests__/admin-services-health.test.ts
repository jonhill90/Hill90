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
    json: vi.fn((data: any, init?: { status?: number; headers?: Record<string, string> }) => ({
      _type: 'NextResponse.json',
      _data: data,
      _status: init?.status ?? 200,
      _headers: init?.headers ?? {},
    })),
  },
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Import after mocks
const { GET } = await import('@/app/api/admin/services/health/route')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('admin services health route', () => {
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
      expect.objectContaining({ status: 401 })
    )
  })

  it('returns 401 when session has no accessToken', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = { user: { roles: ['admin'] } }

    await GET()

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'Not authenticated' },
      expect.objectContaining({ status: 401 })
    )
  })

  it('returns 403 when user lacks admin role', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = { accessToken: 'tok', user: { roles: ['user'] } }

    await GET()

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'Forbidden' },
      expect.objectContaining({ status: 403 })
    )
  })

  it('returns 403 when user has no roles', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = { accessToken: 'tok', user: { roles: [] } }

    await GET()

    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: 'Forbidden' },
      expect.objectContaining({ status: 403 })
    )
  })

  it('returns 200 with services array for admin user', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = { accessToken: 'tok', user: { roles: ['admin'] } }
    mockFetch.mockResolvedValue({ ok: true, status: 200 })

    await GET()

    expect(NextResponse.json).toHaveBeenCalledWith(
      { services: expect.any(Array) },
      expect.objectContaining({ status: 200 })
    )
  })

  it('marks unreachable service as unhealthy', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = { accessToken: 'tok', user: { roles: ['admin'] } }

    // First call succeeds, rest fail
    mockFetch.mockRejectedValue(new Error('connection refused'))

    await GET()

    const call = (NextResponse.json as any).mock.calls[0]
    const data = call[0]

    expect(data.services).toBeDefined()
    expect(Array.isArray(data.services)).toBe(true)

    const unhealthyService = data.services.find((s: any) => s.status === 'unhealthy')
    expect(unhealthyService).toBeDefined()
  })

  it('sets Cache-Control header to private, max-age=10', async () => {
    const { NextResponse } = await import('next/server')
    mockSession = { accessToken: 'tok', user: { roles: ['admin'] } }
    mockFetch.mockResolvedValue({ ok: true, status: 200 })

    await GET()

    const call = (NextResponse.json as any).mock.calls[0]
    const init = call[1]

    expect(init.headers).toBeDefined()
    expect(init.headers['Cache-Control']).toBe('private, max-age=10')
  })
})
