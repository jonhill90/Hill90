import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture the config passed to NextAuth
let capturedConfig: any = null

vi.mock('next-auth', () => ({
  default: (config: any) => {
    capturedConfig = config
    return {
      handlers: {},
      signIn: vi.fn(),
      signOut: vi.fn(),
      auth: vi.fn(),
    }
  },
}))

vi.mock('next-auth/providers/keycloak', () => ({
  default: (opts: any) => ({ id: 'keycloak', ...opts }),
}))

// Set required env vars before importing
process.env.AUTH_KEYCLOAK_ID = 'hill90-ui'
process.env.AUTH_KEYCLOAK_SECRET = 'test-secret'
process.env.AUTH_KEYCLOAK_ISSUER = 'https://auth.hill90.com/realms/hill90'

// Trigger the module load so capturedConfig gets set
await import('@/auth')

const jwtCallback = capturedConfig.callbacks.jwt
const sessionCallback = capturedConfig.callbacks.session

// Helper to build a mock access_token payload
function mockAccessToken(claims: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub: 'user1', realm_roles: ['admin', 'user'], ...claims })).toString('base64url')
  return `${header}.${payload}.fake-sig`
}

describe('jwt callback', () => {
  it('stores accessToken, refreshToken, and roles on initial sign-in', async () => {
    const account = {
      access_token: mockAccessToken(),
      refresh_token: 'refresh-123',
      expires_at: Math.floor(Date.now() / 1000) + 300,
    }

    const result = await jwtCallback({ token: { name: 'Test' }, account })

    expect(result.accessToken).toBe(account.access_token)
    expect(result.refreshToken).toBe('refresh-123')
    expect(result.roles).toEqual(['admin', 'user'])
    expect(result.accessTokenExpires).toBeGreaterThan(Date.now())
  })

  it('stores idToken from account.id_token on initial sign-in', async () => {
    const account = {
      access_token: mockAccessToken(),
      id_token: 'my-id-token-value',
      refresh_token: 'refresh-123',
      expires_at: Math.floor(Date.now() / 1000) + 300,
    }

    const result = await jwtCallback({ token: { name: 'Test' }, account })

    expect(result.idToken).toBe('my-id-token-value')
  })

  it('returns token as-is when not expired', async () => {
    const token = {
      accessToken: 'at-123',
      refreshToken: 'rt-123',
      accessTokenExpires: Date.now() + 60_000,
      roles: ['user'],
    }

    const result = await jwtCallback({ token, account: undefined })

    expect(result).toEqual(token)
  })

  it('calls refresh endpoint when token expired', async () => {
    const token = {
      accessToken: 'old-at',
      refreshToken: 'rt-123',
      accessTokenExpires: Date.now() - 1000,
      roles: ['user'],
    }

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-at',
        refresh_token: 'new-rt',
        expires_in: 300,
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await jwtCallback({ token, account: undefined })

    expect(mockFetch).toHaveBeenCalledOnce()
    expect(result.accessToken).toBe('new-at')
    expect(result.refreshToken).toBe('new-rt')
    expect(result.error).toBeUndefined()

    vi.unstubAllGlobals()
  })

  it('sets error on refresh failure', async () => {
    const token = {
      accessToken: 'old-at',
      refreshToken: 'rt-123',
      accessTokenExpires: Date.now() - 1000,
      roles: ['user'],
    }

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await jwtCallback({ token, account: undefined })

    expect(result.error).toBe('RefreshAccessTokenError')
    expect(result.accessToken).toBeUndefined()
    expect(result.refreshToken).toBeUndefined()
    expect(result.idToken).toBeUndefined()
    expect(result.accessTokenExpires).toBeUndefined()

    vi.unstubAllGlobals()
  })
})

describe('session callback', () => {
  it('exposes accessToken and roles on session', async () => {
    const token = {
      accessToken: 'at-123',
      roles: ['admin', 'user'],
      error: undefined,
    }
    const session = {
      user: { name: 'Test', email: 'test@test.com' },
      expires: '2099-01-01',
    }

    const result = await sessionCallback({ session, token })

    expect(result.accessToken).toBe('at-123')
    expect(result.user.roles).toEqual(['admin', 'user'])
    expect(result.error).toBeUndefined()
  })

  it('exposes idToken on session from token', async () => {
    const token = {
      accessToken: 'at-123',
      idToken: 'id-token-value',
      roles: ['user'],
      error: undefined,
    }
    const session = {
      user: { name: 'Test', email: 'test@test.com' },
      expires: '2099-01-01',
    }

    const result = await sessionCallback({ session, token })

    expect(result.idToken).toBe('id-token-value')
  })

  it('clears session tokens when refresh failed', async () => {
    const token = {
      accessToken: 'stale-at',
      idToken: 'stale-id',
      roles: ['user'],
      error: 'RefreshAccessTokenError',
    }
    const session = {
      user: { name: 'Test', email: 'test@test.com' },
      expires: '2099-01-01',
    }

    const result = await sessionCallback({ session, token })

    expect(result.accessToken).toBeUndefined()
    expect(result.idToken).toBeUndefined()
    expect(result.error).toBe('RefreshAccessTokenError')
  })
})
