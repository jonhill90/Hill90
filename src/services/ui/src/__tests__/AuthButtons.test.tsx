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
  it('renders "Sign in" when session status is unauthenticated', () => {
    mockSession = { data: null, status: 'unauthenticated' }

    render(<AuthButtons />)

    expect(screen.getByText('Sign in')).toBeInTheDocument()
  })

  it('renders username and "Sign out" when session exists', () => {
    mockSession = {
      data: { user: { name: 'Jon Hill' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    expect(screen.getByText('Jon Hill')).toBeInTheDocument()
    expect(screen.getByText('Sign out')).toBeInTheDocument()
  })

  it('renders loading state', () => {
    mockSession = { data: null, status: 'loading' }

    render(<AuthButtons />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })
})
