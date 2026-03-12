import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import CancelButton from '@/app/chat/CancelButton'

describe('CancelButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders nothing when no pending messages', () => {
    const { container } = render(
      <CancelButton threadId="thread-1" hasPending={false} />
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders cancel button when pending', () => {
    render(<CancelButton threadId="thread-1" hasPending={true} />)
    expect(screen.getByTestId('cancel-button')).toBeInTheDocument()
    expect(screen.getByText('Cancel')).toBeInTheDocument()
  })

  it('calls cancel API and onCancelled on click', async () => {
    const onCancelled = vi.fn()
    mockFetch.mockResolvedValue({ ok: true })

    render(
      <CancelButton threadId="thread-1" hasPending={true} onCancelled={onCancelled} />
    )

    fireEvent.click(screen.getByTestId('cancel-button'))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/chat/thread-1/cancel', { method: 'POST' })
      expect(onCancelled).toHaveBeenCalled()
    })
  })

  it('shows cancelling state while request is in flight', async () => {
    let resolveReq: (v: any) => void
    mockFetch.mockReturnValue(new Promise(r => { resolveReq = r }))

    render(<CancelButton threadId="thread-1" hasPending={true} />)

    fireEvent.click(screen.getByTestId('cancel-button'))

    expect(screen.getByText('Cancelling...')).toBeInTheDocument()

    resolveReq!({ ok: true })

    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeInTheDocument()
    })
  })
})
