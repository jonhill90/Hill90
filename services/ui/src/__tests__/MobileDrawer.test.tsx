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

import MobileDrawer from '@/components/MobileDrawer'

describe('MobileDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPathname = '/'
    mockSession = { data: null, status: 'unauthenticated' }
    document.body.style.overflow = ''
  })

  afterEach(() => {
    cleanup()
    document.body.style.overflow = ''
  })

  it('renders nav items when open', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<MobileDrawer open={true} onClose={vi.fn()} />)

    expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /agents/i })).toBeInTheDocument()
  })

  it('calls onClose on close button', () => {
    const onClose = vi.fn()
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<MobileDrawer open={true} onClose={onClose} />)

    const closeButton = screen.getByRole('button', { name: /close/i })
    fireEvent.click(closeButton)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose on Escape', () => {
    const onClose = vi.fn()
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<MobileDrawer open={true} onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose on backdrop click', () => {
    const onClose = vi.fn()
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<MobileDrawer open={true} onClose={onClose} />)

    const backdrop = screen.getByTestId('mobile-drawer-backdrop')
    fireEvent.click(backdrop)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose on pathname change', () => {
    const onClose = vi.fn()
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    const { rerender } = render(<MobileDrawer open={true} onClose={onClose} />)

    // Simulate route change
    mockPathname = '/dashboard'
    rerender(<MobileDrawer open={true} onClose={onClose} />)

    expect(onClose).toHaveBeenCalled()
  })

  it('sets body overflow hidden when open', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<MobileDrawer open={true} onClose={vi.fn()} />)

    expect(document.body.style.overflow).toBe('hidden')
  })

  it('hides API Docs for non-admin', () => {
    mockSession = {
      data: { user: { roles: ['user'] } },
      status: 'authenticated',
    }

    render(<MobileDrawer open={true} onClose={vi.fn()} />)

    expect(screen.queryByRole('link', { name: /api docs/i })).not.toBeInTheDocument()
  })

  it('shows API Docs for admin', () => {
    mockSession = {
      data: { user: { roles: ['admin'] } },
      status: 'authenticated',
    }

    render(<MobileDrawer open={true} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /docs/i }))

    expect(screen.getByRole('link', { name: /api docs/i })).toBeInTheDocument()
  })
})
