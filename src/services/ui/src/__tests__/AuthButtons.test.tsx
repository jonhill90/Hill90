import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next-auth/react
const mockSignIn = vi.fn()
const mockSignOut = vi.fn()
let mockSession: any = { data: null, status: 'unauthenticated' }

vi.mock('next-auth/react', () => ({
  useSession: () => mockSession,
  signIn: (...args: any[]) => mockSignIn(...args),
  signOut: (...args: any[]) => mockSignOut(...args),
}))

import AuthButtons from '@/components/AuthButtons'

describe('AuthButtons', () => {
  it('renders sign-in avatar button when unauthenticated', () => {
    mockSession = { data: null, status: 'unauthenticated' }

    render(<AuthButtons />)

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('renders initials circle and "Sign out" when authenticated', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    expect(screen.getByText('AH')).toBeInTheDocument()
    expect(screen.getByTitle('Admin Hill90')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('renders pulsing placeholder during loading', () => {
    mockSession = { data: null, status: 'loading' }

    const { container } = render(<AuthButtons />)

    expect(container.querySelector('.animate-pulse')).toBeInTheDocument()
  })
})
