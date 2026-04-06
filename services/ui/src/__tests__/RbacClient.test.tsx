import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

let mockSession: any = null

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSession, status: mockSession ? 'authenticated' : 'unauthenticated' }),
}))

import RbacClient from '@/app/admin/rbac/RbacClient'

describe('RbacClient', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows access denied for non-admin users', () => {
    const session = { user: { name: 'Test', roles: ['user'] } } as any
    render(<RbacClient session={session} />)
    expect(screen.getByText('Admin access required to view RBAC settings.')).toBeInTheDocument()
  })

  it('renders role table for admin users', () => {
    const session = { user: { name: 'Admin', roles: ['admin', 'user', 'offline_access'] } } as any
    render(<RbacClient session={session} />)

    expect(screen.getByText('Roles & Access Control')).toBeInTheDocument()
    expect(screen.getByText('Your Roles')).toBeInTheDocument()
    expect(screen.getByText('Platform Roles')).toBeInTheDocument()
  })

  it('shows current user role badges', () => {
    const session = { user: { name: 'Admin', roles: ['admin', 'user'] } } as any
    render(<RbacClient session={session} />)

    const badges = screen.getAllByText('admin')
    expect(badges.length).toBeGreaterThanOrEqual(1)
  })

  it('displays all platform roles in table', () => {
    const session = { user: { name: 'Admin', roles: ['admin', 'user'] } } as any
    render(<RbacClient session={session} />)

    expect(screen.getByText('offline_access')).toBeInTheDocument()
    expect(screen.getByText('uma_authorization')).toBeInTheDocument()
    expect(screen.getByText('default-roles-hill90')).toBeInTheDocument()
  })

  it('shows Yes/No indicators for role membership', () => {
    const session = { user: { name: 'Admin', roles: ['admin', 'user'] } } as any
    render(<RbacClient session={session} />)

    const yesIndicators = screen.getAllByText('Yes')
    const noIndicators = screen.getAllByText('No')
    expect(yesIndicators.length).toBe(2) // admin, user
    expect(noIndicators.length).toBe(3) // offline_access, uma_authorization, default-roles-hill90
  })

  it('expands role to show permissions on click', () => {
    const session = { user: { name: 'Admin', roles: ['admin', 'user'] } } as any
    render(<RbacClient session={session} />)

    // Click the offline_access row (unique text, no badge conflict)
    const row = screen.getByText('offline_access').closest('tr')!
    fireEvent.click(row)

    expect(screen.getByText('Obtain refresh tokens for session persistence')).toBeInTheDocument()
  })

  it('collapses role permissions on second click', () => {
    const session = { user: { name: 'Admin', roles: ['admin', 'user'] } } as any
    render(<RbacClient session={session} />)

    const row = screen.getByText('offline_access').closest('tr')!
    fireEvent.click(row)
    expect(screen.getByText('Obtain refresh tokens for session persistence')).toBeInTheDocument()

    fireEvent.click(row)
    expect(screen.queryByText('Obtain refresh tokens for session persistence')).not.toBeInTheDocument()
  })
})
