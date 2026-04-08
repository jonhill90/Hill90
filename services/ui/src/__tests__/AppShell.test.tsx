import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next-auth/react
let mockSession: any = { data: null, status: 'unauthenticated' }

vi.mock('next-auth/react', () => ({
  useSession: () => mockSession,
  signIn: vi.fn(),
}))

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
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

import AppShell from '@/components/AppShell'

describe('AppShell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorageMock.clear()
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }
  })

  afterEach(() => {
    cleanup()
  })

  it('renders sidebar nav items through shell', () => {
    render(<AppShell><div>Page content</div></AppShell>)

    // Sidebar should render nav links (hidden on mobile via CSS, but present in DOM)
    expect(screen.getByText('Page content')).toBeInTheDocument()
    // Nav links appear in sidebar (desktop) and potentially mobile drawer
    const homeLinks = screen.getAllByRole('link', { name: /home/i })
    expect(homeLinks.length).toBeGreaterThanOrEqual(1)
    const dashboardLinks = screen.getAllByRole('link', { name: /dashboard/i })
    expect(dashboardLinks.length).toBeGreaterThanOrEqual(1)
  })

  it('renders navExtra breadcrumb through shell', () => {
    render(
      <AppShell navExtra={<span data-testid="breadcrumb">Settings</span>}>
        <div>Content</div>
      </AppShell>
    )

    expect(screen.getByTestId('breadcrumb')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('renders footer', () => {
    render(<AppShell><div>Content</div></AppShell>)

    expect(screen.getByText(/© \d{4} Hill90/)).toBeInTheDocument()
  })
})
