import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import SecretsClient from '../app/harness/secrets/SecretsClient'

let mockSession: any = null

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSession, status: mockSession ? 'authenticated' : 'unauthenticated' }),
  SessionProvider: ({ children }: any) => children,
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/harness/secrets',
  useRouter: () => ({ push: vi.fn() }),
}))

const mockInventory = {
  paths: [
    {
      path: 'secret/shared/database',
      keys: [
        { key: 'DB_USER', consumers: ['db', 'api'] },
        { key: 'DB_PASSWORD', consumers: ['db', 'api', 'ai'] },
      ],
      keyCount: 2,
    },
    {
      path: 'secret/auth/config',
      keys: [
        { key: 'KC_ADMIN_USERNAME', consumers: ['auth'] },
        { key: 'KC_ADMIN_PASSWORD', consumers: ['auth'] },
      ],
      keyCount: 2,
    },
  ],
  totalPaths: 2,
  totalKeys: 4,
  approleServices: ['db', 'api', 'ai', 'auth'],
}

const mockStatus = {
  available: true,
  sealed: false,
  initialized: true,
  version: '2.0.0',
  cluster_name: 'hill90-vault',
}

describe('SecretsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  afterEach(() => {
    cleanup()
    mockSession = null
  })

  it('shows access denied for non-admin (T5)', () => {
    mockSession = { user: { name: 'Regular User', roles: ['user'] } }
    render(<SecretsClient />)
    expect(screen.getByText('Access Denied')).toBeInTheDocument()
    expect(screen.getByText(/admin privileges/)).toBeInTheDocument()
  })

  it('renders secrets inventory table (T4)', async () => {
    mockSession = { user: { name: 'Admin', roles: ['admin', 'user'] } }

    ;(global.fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => mockInventory })
      .mockResolvedValueOnce({ ok: true, json: async () => mockStatus })

    render(<SecretsClient />)

    // Wait for data to load
    expect(await screen.findByText('Secrets')).toBeInTheDocument()
    expect(screen.getByText('2 vault paths')).toBeInTheDocument()
    expect(screen.getByText('4 total keys')).toBeInTheDocument()

    // Vault status bar
    expect(screen.getByText('Vault unsealed')).toBeInTheDocument()

    // Table paths
    expect(screen.getByText('secret/shared/database')).toBeInTheDocument()
    expect(screen.getByText('secret/auth/config')).toBeInTheDocument()
  })

  it('expands row to show key names (T6)', async () => {
    mockSession = { user: { name: 'Admin', roles: ['admin', 'user'] } }

    ;(global.fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => mockInventory })
      .mockResolvedValueOnce({ ok: true, json: async () => mockStatus })

    render(<SecretsClient />)

    // Wait for table to render
    const dbRow = await screen.findByText('secret/shared/database')
    expect(dbRow).toBeInTheDocument()

    // Keys should not be visible before expanding
    expect(screen.queryByText('DB_USER')).not.toBeInTheDocument()

    // Click to expand
    fireEvent.click(dbRow.closest('tr')!)

    // Keys should now be visible
    expect(screen.getByText('DB_USER')).toBeInTheDocument()
    expect(screen.getByText('DB_PASSWORD')).toBeInTheDocument()
  })

  it('shows vault unavailable status', async () => {
    mockSession = { user: { name: 'Admin', roles: ['admin', 'user'] } }

    const unavailableStatus = { available: false, sealed: null, initialized: null, version: null, cluster_name: null }

    ;(global.fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => mockInventory })
      .mockResolvedValueOnce({ ok: true, json: async () => unavailableStatus })

    render(<SecretsClient />)

    expect(await screen.findByText('Vault unreachable')).toBeInTheDocument()
  })

  it('shows vault sealed status', async () => {
    mockSession = { user: { name: 'Admin', roles: ['admin', 'user'] } }

    const sealedStatus = { available: true, sealed: true, initialized: true, version: '2.0.0', cluster_name: null }

    ;(global.fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => mockInventory })
      .mockResolvedValueOnce({ ok: true, json: async () => sealedStatus })

    render(<SecretsClient />)

    expect(await screen.findByText('Vault sealed')).toBeInTheDocument()
  })

  it('shows error state on fetch failure', async () => {
    mockSession = { user: { name: 'Admin', roles: ['admin', 'user'] } }

    ;(global.fetch as any)
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => mockStatus })

    render(<SecretsClient />)

    expect(await screen.findByText('Error')).toBeInTheDocument()
    expect(screen.getByText('Failed to load secrets inventory')).toBeInTheDocument()
  })
})
