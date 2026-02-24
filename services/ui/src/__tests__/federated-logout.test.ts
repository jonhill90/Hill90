import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Track what NextResponse.redirect receives
let redirectUrl: URL | null = null
let responseCookies: Map<string, { value: string; maxAge: number; path: string }>

const mockResponseCookies = {
  set: vi.fn((name: string, value: string, opts: any) => {
    responseCookies.set(name, { value, maxAge: opts.maxAge, path: opts.path })
  }),
}

vi.mock('next/server', () => ({
  NextResponse: {
    redirect: vi.fn((url: URL) => {
      redirectUrl = url
      return { cookies: mockResponseCookies }
    }),
  },
}))

// Mock session returned by auth()
let mockSession: any = null

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => mockSession),
}))

// Mock cookies()
let mockCookieList: { name: string; value: string }[] = []

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    getAll: () => mockCookieList,
  })),
}))

// Import the route handler after mocks
const { GET } = await import('@/app/api/auth/federated-logout/route')

describe('federated-logout route', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    redirectUrl = null
    responseCookies = new Map()
    process.env = {
      ...originalEnv,
      AUTH_KEYCLOAK_ISSUER: 'https://auth.hill90.com/realms/hill90',
      AUTH_KEYCLOAK_ID: 'hill90-ui',
      AUTH_KEYCLOAK_SECRET: 'test-secret',
      AUTH_URL: 'https://hill90.com',
    }
    mockCookieList = [
      { name: 'authjs.session-token', value: 'abc' },
      { name: 'authjs.session-token.0', value: 'chunk0' },
      { name: 'authjs.session-token.1', value: 'chunk1' },
      { name: 'authjs.callback-url', value: 'https://hill90.com' },
      { name: '__Secure-authjs.session-token', value: 'secure-abc' },
      { name: '__Host-authjs.csrf-token', value: 'csrf-abc' },
      { name: 'other-cookie', value: 'keep-me' },
    ]
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('builds Keycloak logout URL with id_token_hint when session has idToken', async () => {
    mockSession = { idToken: 'my-id-token', user: { name: 'Test' } }

    await GET()

    expect(redirectUrl).not.toBeNull()
    expect(redirectUrl!.pathname).toBe('/realms/hill90/protocol/openid-connect/logout')
    expect(redirectUrl!.searchParams.get('id_token_hint')).toBe('my-id-token')
    expect(redirectUrl!.searchParams.has('client_id')).toBe(false)
  })

  it('falls back to client_id when idToken is missing', async () => {
    mockSession = { user: { name: 'Test' } }

    await GET()

    expect(redirectUrl!.searchParams.get('client_id')).toBe('hill90-ui')
    expect(redirectUrl!.searchParams.has('id_token_hint')).toBe(false)
  })

  it('falls back to client_id when session is null', async () => {
    mockSession = null

    await GET()

    expect(redirectUrl!.searchParams.get('client_id')).toBe('hill90-ui')
  })

  it('post_logout_redirect_uri is derived from AUTH_URL env var', async () => {
    mockSession = { idToken: 'tok', user: { name: 'Test' } }

    await GET()

    expect(redirectUrl!.searchParams.get('post_logout_redirect_uri')).toBe('https://hill90.com/')
  })

  it('clears all cookies with authjs., __Secure-authjs., or __Host-authjs. prefix', async () => {
    mockSession = { idToken: 'tok', user: { name: 'Test' } }

    await GET()

    // Should clear 6 Auth.js cookies, not the 'other-cookie'
    expect(mockResponseCookies.set).toHaveBeenCalledTimes(6)

    const clearedNames = mockResponseCookies.set.mock.calls.map((c: any) => c[0])
    expect(clearedNames).toContain('authjs.session-token')
    expect(clearedNames).toContain('authjs.session-token.0')
    expect(clearedNames).toContain('authjs.session-token.1')
    expect(clearedNames).toContain('authjs.callback-url')
    expect(clearedNames).toContain('__Secure-authjs.session-token')
    expect(clearedNames).toContain('__Host-authjs.csrf-token')
    expect(clearedNames).not.toContain('other-cookie')

    // All cleared with maxAge: 0 and path /
    for (const call of mockResponseCookies.set.mock.calls) {
      expect(call[1]).toBe('')
      expect(call[2].maxAge).toBe(0)
      expect(call[2].path).toBe('/')
    }
  })

  it('sets secure flag on __Secure- and __Host- prefixed cookies', async () => {
    mockSession = { idToken: 'tok', user: { name: 'Test' } }

    await GET()

    const calls = mockResponseCookies.set.mock.calls
    const byName = (name: string) => calls.find((c: any) => c[0] === name)

    expect(byName('authjs.session-token')![2].secure).toBe(false)
    expect(byName('__Secure-authjs.session-token')![2].secure).toBe(true)
    expect(byName('__Host-authjs.csrf-token')![2].secure).toBe(true)
  })

  it('returns 302 redirect to Keycloak logout URL', async () => {
    mockSession = { idToken: 'tok', user: { name: 'Test' } }
    const { NextResponse } = await import('next/server')

    await GET()

    expect(NextResponse.redirect).toHaveBeenCalledOnce()
    expect(redirectUrl!.origin).toBe('https://auth.hill90.com')
  })
})
