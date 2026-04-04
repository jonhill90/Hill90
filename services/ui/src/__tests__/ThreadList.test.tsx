import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

vi.mock('lucide-react', () => ({
  Users: (props: any) => <span data-testid="icon-users" {...props} />,
  Trash2: (props: any) => <span data-testid="icon-trash" {...props} />,
}))

import ThreadList from '@/app/chat/ThreadList'
import type { ChatThread } from '@/app/chat/ChatLayout'

function makeThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'thread-1',
    type: 'direct',
    title: 'Test Thread',
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_message: 'Hello there',
    last_author_type: 'human',
    agent: { id: 'agent-1', agent_id: 'bot-1', name: 'TestBot', status: 'running' },
    ...overrides,
  }
}

describe('ThreadList', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows loading state', () => {
    render(<ThreadList threads={[]} loading={true} onDelete={vi.fn()} />)
    expect(screen.getByText('Loading...')).toBeInTheDocument()
  })

  it('shows empty state', () => {
    render(<ThreadList threads={[]} loading={false} onDelete={vi.fn()} />)
    expect(screen.getByText(/No conversations yet/)).toBeInTheDocument()
  })

  it('renders thread list', () => {
    const threads = [
      makeThread({ id: 'thread-1', title: 'First Chat' }),
      makeThread({ id: 'thread-2', title: 'Second Chat' }),
    ]
    render(<ThreadList threads={threads} loading={false} onDelete={vi.fn()} />)
    expect(screen.getByText('First Chat')).toBeInTheDocument()
    expect(screen.getByText('Second Chat')).toBeInTheDocument()
  })

  it('highlights active thread', () => {
    const threads = [makeThread({ id: 'thread-1', title: 'Active Thread' })]
    const { container } = render(
      <ThreadList threads={threads} loading={false} activeThreadId="thread-1" onDelete={vi.fn()} />
    )
    const link = container.querySelector('a[href="/chat/thread-1"]')
    expect(link?.className).toContain('bg-navy-800')
    expect(link?.className).toContain('border-l-brand-500')
  })

  it('shows group thread indicator', () => {
    const threads = [
      makeThread({ id: 'thread-g', type: 'group', title: null, agent_count: 3 }),
    ]
    render(<ThreadList threads={threads} loading={false} onDelete={vi.fn()} />)
    expect(screen.getByText('Group (3 agents)')).toBeInTheDocument()
    expect(screen.getByTestId('group-icon')).toBeInTheDocument()
  })

  it('calls onDelete when delete confirmed', () => {
    const onDelete = vi.fn()
    const threads = [makeThread({ id: 'thread-1', title: 'Delete Me' })]
    render(<ThreadList threads={threads} loading={false} onDelete={onDelete} />)
    fireEvent.click(screen.getByTestId('delete-thread-thread-1'))
    fireEvent.click(screen.getByTestId('confirm-yes-thread-1'))
    expect(onDelete).toHaveBeenCalledWith('thread-1')
  })
})
