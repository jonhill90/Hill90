import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { name: 'Jon Hill', email: 'jon@hill90.com', roles: ['user'] } }, status: 'authenticated' }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/profile',
}))

import ProfileClient from '@/app/profile/ProfileClient'

const MOCK_PROFILE = { firstName: 'Jon', lastName: 'Hill', email: 'jon@hill90.com' }
const mockSession = { user: { name: 'Jon Hill', email: 'jon@hill90.com', roles: ['user'] } } as any

function mockFetch() {
  return vi.fn((url: string, opts?: any) => {
    if (typeof url === 'string' && url.endsWith('/api/profile/avatar')) {
      return Promise.resolve({ ok: false, status: 404 })
    }
    if (typeof url === 'string' && url.endsWith('/api/profile')) {
      if (opts?.method === 'PATCH') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PROFILE) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PROFILE) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('ProfileClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch())
  })

  afterEach(() => {
    cleanup()
  })

  it('renders profile page title', async () => {
    render(<ProfileClient session={mockSession} />)
    await waitFor(() => {
      expect(screen.getByText('Profile')).toBeInTheDocument()
    })
  })

  it('shows display name section with first/last name inputs', async () => {
    render(<ProfileClient session={mockSession} />)
    await waitFor(() => {
      expect(screen.getByText('Display Name')).toBeInTheDocument()
    })
    expect(screen.getByLabelText(/first name/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/last name/i)).toBeInTheDocument()
  })

  it('populates name fields from API', async () => {
    render(<ProfileClient session={mockSession} />)
    await waitFor(() => {
      expect(screen.getByDisplayValue('Jon')).toBeInTheDocument()
      expect(screen.getByDisplayValue('Hill')).toBeInTheDocument()
    })
  })

  it('shows email from profile', async () => {
    render(<ProfileClient session={mockSession} />)
    await waitFor(() => {
      expect(screen.getByText('jon@hill90.com')).toBeInTheDocument()
    })
  })

  it('shows avatar section', async () => {
    render(<ProfileClient session={mockSession} />)
    await waitFor(() => {
      expect(screen.getByText('Profile Picture')).toBeInTheDocument()
      expect(screen.getByText('Upload')).toBeInTheDocument()
    })
  })

  it('shows initials when no avatar', async () => {
    render(<ProfileClient session={mockSession} />)
    await waitFor(() => {
      expect(screen.getByText('JH')).toBeInTheDocument()
    })
  })

  it('shows password change section', async () => {
    render(<ProfileClient session={mockSession} />)
    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { level: 2 })
      const passwordHeading = headings.find(h => h.textContent === 'Change Password')
      expect(passwordHeading).toBeTruthy()
    })
  })

  it('save button exists for name', async () => {
    render(<ProfileClient session={mockSession} />)
    await waitFor(() => {
      expect(screen.getByText('Save')).toBeInTheDocument()
    })
  })
})
