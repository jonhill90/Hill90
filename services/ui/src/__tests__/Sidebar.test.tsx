import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next-auth/react
let mockSession: any = { data: null, status: 'unauthenticated' }

vi.mock('next-auth/react', () => ({
  useSession: () => mockSession,
}))

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

// Mock next/navigation
let mockPathname = '/'
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}))

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
  }
})()

Object.defineProperty(window, 'localStorage', { value: localStorageMock })

import Sidebar from '@/components/Sidebar'

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorageMock.clear()
    // Reset getItem to default after any mockReturnValue overrides (e.g. collapsed test)
    localStorageMock.getItem.mockImplementation((key: string) => null)
    mockPathname = '/'
    mockSession = { data: null, status: 'unauthenticated' }
  })

  afterEach(() => {
    cleanup()
  })

  it('renders core nav links for non-admin', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /agents/i })).toBeInTheDocument()
  })

  it('renders API Docs link for admin users', () => {
    mockSession = {
      data: { user: { roles: ['admin'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: /docs/i }))

    expect(screen.getByRole('link', { name: /api docs/i })).toBeInTheDocument()
  })

  it('hides API Docs for non-admin', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    expect(screen.queryByRole('link', { name: /api docs/i })).not.toBeInTheDocument()
  })

  it('highlights active route', () => {
    mockPathname = '/dashboard'
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    const dashboardLink = screen.getByRole('link', { name: /dashboard/i })
    expect(dashboardLink.getAttribute('aria-current')).toBe('page')
  })

  it('collapse persists to localStorage', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    const collapseButton = screen.getByRole('button', { name: /collapse/i })
    fireEvent.click(collapseButton)

    expect(localStorageMock.setItem).toHaveBeenCalledWith('sidebar-collapsed', 'true')
  })

  it('renders Build/Connect/Observe nav groups', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    const buildButton = screen.getByRole('button', { name: /build/i })
    expect(buildButton).toBeInTheDocument()
    fireEvent.click(buildButton)
    expect(screen.getByRole('link', { name: /skills/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^library$/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /connect/i }))
    expect(screen.getByRole('link', { name: /connections/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /models/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /observe/i }))
    expect(screen.getByRole('link', { name: /usage/i })).toBeInTheDocument()
  })

  it('highlights active route in Connect group', async () => {
    mockPathname = '/harness/connections'
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    // Group may auto-expand via useEffect; click to expand if not
    const connectButton = screen.getByRole('button', { name: /connect/i })
    if (!screen.queryByRole('link', { name: /connections/i })) {
      fireEvent.click(connectButton)
    }

    await waitFor(() => {
      const connectionsLink = screen.getByRole('link', { name: /connections/i })
      expect(connectionsLink.getAttribute('aria-current')).toBe('page')
    })
  })

  it('hides labels when collapsed', () => {
    localStorageMock.getItem.mockReturnValue('true')
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    // Labels should be visually hidden (sr-only) when collapsed
    const homeLink = screen.getByRole('link', { name: /home/i })
    const label = homeLink.querySelector('[data-sidebar-label]')
    expect(label).toHaveClass('sr-only')
  })

  it('T1: nav shows Library label in Build group', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: /build/i }))

    expect(screen.getByText('Library')).toBeInTheDocument()
    expect(screen.queryByText('Shared Knowledge')).not.toBeInTheDocument()
  })

  it('T2: nav shows Dependencies label for admin in Admin group', () => {
    mockSession = {
      data: { user: { roles: ['admin'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: /admin/i }))

    expect(screen.getByText('Dependencies')).toBeInTheDocument()
  })

  it('T3: nav shows Knowledge inside Build group', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: /build/i }))
    expect(screen.getByRole('link', { name: /knowledge/i })).toBeInTheDocument()
  })

  it('T4: renders nothing when logged out', () => {
    mockSession = { data: null, status: 'unauthenticated' }

    const { container } = render(<Sidebar />)

    expect(container.innerHTML).toBe('')
  })

  it('T5: renders nav items when logged in', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /agents/i })).toBeInTheDocument()
  })
})
