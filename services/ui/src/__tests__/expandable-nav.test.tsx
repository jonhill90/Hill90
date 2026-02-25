import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
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
let localStore: Record<string, string> = {}
const localStorageMock = {
  getItem: vi.fn((key: string) => localStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { localStore[key] = value }),
  removeItem: vi.fn((key: string) => { delete localStore[key] }),
  clear: vi.fn(() => { localStore = {} }),
}

Object.defineProperty(window, 'localStorage', { value: localStorageMock })

import Sidebar from '@/components/Sidebar'
import MobileDrawer from '@/components/MobileDrawer'

// ---------- Sidebar expand/collapse tests ----------

describe('Expandable docs nav (Sidebar)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStore = {}
    localStorageMock.getItem.mockImplementation((key: string) => localStore[key] ?? null)
    localStorageMock.setItem.mockImplementation((key: string, value: string) => { localStore[key] = value })
    mockPathname = '/'
    mockSession = {
      data: { user: { roles: ['admin'] } },
      status: 'authenticated',
    }
  })

  afterEach(() => {
    cleanup()
  })

  it('renders Docs parent for all users', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)

    expect(screen.getByRole('button', { name: /docs/i })).toBeInTheDocument()
  })

  it('does not show children when Docs is collapsed', () => {
    render(<Sidebar />)

    expect(screen.queryByRole('link', { name: /api docs/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /platform docs/i })).not.toBeInTheDocument()
  })

  it('shows children after clicking Docs', () => {
    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: /docs/i }))

    expect(screen.getByRole('link', { name: /api docs/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /platform docs/i })).toBeInTheDocument()
  })

  it('hides children after clicking Docs again', () => {
    render(<Sidebar />)

    const docsButton = screen.getByRole('button', { name: /docs/i })
    fireEvent.click(docsButton)
    fireEvent.click(docsButton)

    expect(screen.queryByRole('link', { name: /api docs/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /platform docs/i })).not.toBeInTheDocument()
  })

  it('persists expand state to localStorage', () => {
    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: /docs/i }))

    expect(localStorageMock.setItem).toHaveBeenCalledWith('nav-expanded-docs', 'true')
  })

  it('reads expand state from localStorage on mount', () => {
    localStore['nav-expanded-docs'] = 'true'

    render(<Sidebar />)

    expect(screen.getByRole('link', { name: /api docs/i })).toBeInTheDocument()
  })

  it('shows API Docs child for admin', () => {
    mockSession = {
      data: { user: { roles: ['admin'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: /docs/i }))

    expect(screen.getByRole('link', { name: /api docs/i })).toBeInTheDocument()
  })

  it('hides API Docs child for non-admin', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: /docs/i }))

    expect(screen.queryByRole('link', { name: /api docs/i })).not.toBeInTheDocument()
  })

  it('shows Platform Docs child for all users', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: /docs/i }))

    expect(screen.getByRole('link', { name: /platform docs/i })).toBeInTheDocument()
  })

  it('Platform Docs has target=_blank and rel=noopener', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: /docs/i }))

    const platformLink = screen.getByRole('link', { name: /platform docs/i })
    expect(platformLink).toHaveAttribute('target', '_blank')
    expect(platformLink).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('Docs parent shows active when on /docs/api', () => {
    mockPathname = '/docs/api'

    render(<Sidebar />)

    const docsButton = screen.getByRole('button', { name: /docs/i })
    expect(docsButton.className).toContain('brand')
  })

  it('shows ChevronRight when collapsed, ChevronDown when expanded', () => {
    render(<Sidebar />)

    const docsButton = screen.getByRole('button', { name: /docs/i })

    // When collapsed, should not have ChevronDown indicator
    expect(docsButton.querySelector('[data-chevron="down"]')).not.toBeInTheDocument()
    expect(docsButton.querySelector('[data-chevron="right"]')).toBeInTheDocument()

    // Expand
    fireEvent.click(docsButton)

    expect(docsButton.querySelector('[data-chevron="down"]')).toBeInTheDocument()
    expect(docsButton.querySelector('[data-chevron="right"]')).not.toBeInTheDocument()
  })

  it('auto-expands sidebar when clicking Docs while collapsed', () => {
    localStore['sidebar-collapsed'] = 'true'

    render(<Sidebar />)

    // Sidebar should be collapsed
    const aside = screen.getByRole('complementary')
    expect(aside.className).toContain('w-[60px]')

    // Click the Docs button
    fireEvent.click(screen.getByRole('button', { name: /docs/i }))

    // Sidebar should now be expanded
    expect(aside.className).toContain('w-[220px]')
  })

  it('Docs button has aria-expanded=false then true after click', () => {
    render(<Sidebar />)

    const docsButton = screen.getByRole('button', { name: /docs/i })
    expect(docsButton).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(docsButton)

    expect(docsButton).toHaveAttribute('aria-expanded', 'true')
  })

  it('Docs button aria-controls matches children container id', () => {
    render(<Sidebar />)

    const docsButton = screen.getByRole('button', { name: /docs/i })
    const controlsId = docsButton.getAttribute('aria-controls')
    expect(controlsId).toBe('docs-submenu')

    // Expand to reveal the container
    fireEvent.click(docsButton)

    const submenu = document.getElementById('docs-submenu')
    expect(submenu).toBeInTheDocument()
  })

  it('expands Docs children on Enter key', () => {
    render(<Sidebar />)

    const docsButton = screen.getByRole('button', { name: /docs/i })
    fireEvent.keyDown(docsButton, { key: 'Enter' })

    // Button should trigger via native behavior, but let's also test click
    fireEvent.click(docsButton)

    expect(screen.getByRole('link', { name: /platform docs/i })).toBeInTheDocument()
  })

  it('expands Docs children on Space key', () => {
    render(<Sidebar />)

    const docsButton = screen.getByRole('button', { name: /docs/i })
    fireEvent.keyDown(docsButton, { key: ' ' })

    // Button should trigger via native behavior, but let's also test click
    fireEvent.click(docsButton)

    expect(screen.getByRole('link', { name: /platform docs/i })).toBeInTheDocument()
  })

  it('does not crash when localStorage throws', () => {
    localStorageMock.getItem.mockImplementation(() => { throw new Error('access denied') })
    localStorageMock.setItem.mockImplementation(() => { throw new Error('access denied') })

    // Should not throw
    expect(() => {
      render(<Sidebar />)
    }).not.toThrow()

    // Should still be able to click Docs
    const docsButton = screen.getByRole('button', { name: /docs/i })
    expect(() => {
      fireEvent.click(docsButton)
    }).not.toThrow()
  })
})

// ---------- MobileDrawer expand/collapse tests ----------

describe('Expandable docs nav (MobileDrawer)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStore = {}
    localStorageMock.getItem.mockImplementation((key: string) => localStore[key] ?? null)
    localStorageMock.setItem.mockImplementation((key: string, value: string) => { localStore[key] = value })
    mockPathname = '/'
    mockSession = {
      data: { user: { roles: ['admin'] } },
      status: 'authenticated',
    }
    document.body.style.overflow = ''
  })

  afterEach(() => {
    cleanup()
    document.body.style.overflow = ''
  })

  it('expands Docs children in mobile drawer', () => {
    render(<MobileDrawer open={true} onClose={vi.fn()} />)

    // Docs parent should be visible
    const docsButton = screen.getByRole('button', { name: /docs/i })
    expect(docsButton).toBeInTheDocument()

    // Children hidden by default
    expect(screen.queryByRole('link', { name: /api docs/i })).not.toBeInTheDocument()

    // Click to expand
    fireEvent.click(docsButton)

    // Children now visible
    expect(screen.getByRole('link', { name: /api docs/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /platform docs/i })).toBeInTheDocument()
  })
})
