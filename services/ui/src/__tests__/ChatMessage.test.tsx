import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import ChatMessage from '@/app/chat/ChatMessage'
import type { Message } from '@/app/chat/ChatView'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    seq: 1,
    thread_id: 'thread-1',
    author_id: 'user-1',
    author_type: 'human',
    role: 'user',
    content: 'Hello world',
    status: 'complete',
    model: null,
    input_tokens: null,
    output_tokens: null,
    duration_ms: null,
    error_message: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('ChatMessage', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders user message content', () => {
    render(<ChatMessage message={makeMessage()} isOwnMessage={true} />)
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('renders assistant message content', () => {
    render(
      <ChatMessage
        message={makeMessage({
          author_type: 'agent',
          role: 'assistant',
          content: 'Hello from agent!',
        })}
        isOwnMessage={false}
      />
    )
    expect(screen.getByText('Hello from agent!')).toBeInTheDocument()
  })

  it('shows thinking indicator for pending messages', () => {
    render(
      <ChatMessage
        message={makeMessage({
          author_type: 'agent',
          role: 'assistant',
          status: 'pending',
          content: '',
        })}
        isOwnMessage={false}
      />
    )
    expect(screen.getByText('Thinking...')).toBeInTheDocument()
  })

  it('shows error message for error status', () => {
    render(
      <ChatMessage
        message={makeMessage({
          author_type: 'agent',
          role: 'assistant',
          status: 'error',
          error_message: 'Inference timed out',
        })}
        isOwnMessage={false}
      />
    )
    expect(screen.getByText('Inference timed out')).toBeInTheDocument()
  })

  it('shows model metadata for complete assistant messages', () => {
    render(
      <ChatMessage
        message={makeMessage({
          author_type: 'agent',
          role: 'assistant',
          content: 'Response here',
          model: 'gpt-4o-mini',
          duration_ms: 1500,
          input_tokens: 42,
          output_tokens: 128,
        })}
        isOwnMessage={false}
      />
    )
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument()
    expect(screen.getByText('1.5s')).toBeInTheDocument()
    expect(screen.getByText('170 tok')).toBeInTheDocument()
  })

  it('shows fallback error when no error_message provided', () => {
    render(
      <ChatMessage
        message={makeMessage({
          author_type: 'agent',
          role: 'assistant',
          status: 'error',
          error_message: null,
        })}
        isOwnMessage={false}
      />
    )
    expect(screen.getByText('An error occurred')).toBeInTheDocument()
  })
})
