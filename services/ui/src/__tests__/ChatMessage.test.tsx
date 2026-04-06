import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import ChatMessage from '@/app/chat/ChatMessage'
import type { Message } from '@/app/chat/ChatView'
import type { ChatAgent } from '@/app/chat/ChatLayout'

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
    reply_to: null,
    chain_id: null,
    chain_hop: null,
    triggered_by: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const MOCK_AGENTS: ChatAgent[] = [
  { id: 'agent-1', agent_id: 'research-bot', name: 'ResearchBot', status: 'running' },
  { id: 'agent-2', agent_id: 'writer-bot', name: 'WriterBot', status: 'running' },
]

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

  // Phase 1B: Agent name badges in group threads
  it('shows agent name badge in group thread', () => {
    render(
      <ChatMessage
        message={makeMessage({
          id: 'msg-a1',
          author_id: 'agent-1',
          author_type: 'agent',
          role: 'assistant',
          content: 'Research result',
        })}
        isOwnMessage={false}
        isGroup={true}
        agents={MOCK_AGENTS}
      />
    )
    expect(screen.getByTestId('agent-badge')).toBeInTheDocument()
    expect(screen.getByText('ResearchBot')).toBeInTheDocument()
  })

  it('does not show agent badge in direct thread', () => {
    render(
      <ChatMessage
        message={makeMessage({
          author_id: 'agent-1',
          author_type: 'agent',
          role: 'assistant',
          content: 'Response',
        })}
        isOwnMessage={false}
        isGroup={false}
        agents={MOCK_AGENTS}
      />
    )
    expect(screen.queryByTestId('agent-badge')).not.toBeInTheDocument()
  })

  it('does not show agent badge on user messages in group thread', () => {
    render(
      <ChatMessage
        message={makeMessage({
          role: 'user',
          content: 'Question',
        })}
        isOwnMessage={true}
        isGroup={true}
        agents={MOCK_AGENTS}
      />
    )
    expect(screen.queryByTestId('agent-badge')).not.toBeInTheDocument()
  })

  it('shows agent-specific thinking text in group pending', () => {
    render(
      <ChatMessage
        message={makeMessage({
          author_id: 'agent-2',
          author_type: 'agent',
          role: 'assistant',
          status: 'pending',
          content: '',
        })}
        isOwnMessage={false}
        isGroup={true}
        agents={MOCK_AGENTS}
      />
    )
    expect(screen.getByText('WriterBot is thinking...')).toBeInTheDocument()
  })

  // T16: Chain provenance renders
  it('ChatMessage renders triggered_by annotation', () => {
    render(
      <ChatMessage
        message={makeMessage({
          author_id: 'agent-2',
          author_type: 'agent',
          role: 'assistant',
          content: 'Chained response',
          triggered_by: 'trigger-msg-1',
          chain_id: 'chain-uuid',
          chain_hop: 1,
        })}
        isOwnMessage={false}
        isGroup={true}
        agents={MOCK_AGENTS}
        triggerAgentName="ResearchBot"
      />
    )
    expect(screen.getByTestId('chain-provenance')).toBeInTheDocument()
    expect(screen.getByText('Triggered by @ResearchBot')).toBeInTheDocument()
  })

  // T17: Chain annotation shows agent name
  it('chain provenance shows agent name', () => {
    render(
      <ChatMessage
        message={makeMessage({
          author_id: 'agent-1',
          author_type: 'agent',
          role: 'assistant',
          content: 'Follow-up response',
          triggered_by: 'trigger-msg-2',
          chain_id: 'chain-uuid-2',
          chain_hop: 2,
        })}
        isOwnMessage={false}
        isGroup={true}
        agents={MOCK_AGENTS}
        triggerAgentName="WriterBot"
      />
    )
    const provenance = screen.getByTestId('chain-provenance')
    expect(provenance).toHaveTextContent('Triggered by @WriterBot')
  })

  // AI-167: Stale error messages
  it('renders stale message dimmed with original error text', () => {
    render(
      <ChatMessage
        message={makeMessage({
          author_type: 'agent',
          role: 'assistant',
          status: 'stale',
          error_message: 'token expired',
        })}
        isOwnMessage={false}
      />
    )
    const stale = screen.getByTestId('stale-message')
    expect(stale).toBeInTheDocument()
    expect(stale).toHaveTextContent('token expired')
  })

  it('renders stale fallback text when no error_message', () => {
    render(
      <ChatMessage
        message={makeMessage({
          author_type: 'agent',
          role: 'assistant',
          status: 'stale',
          error_message: null,
        })}
        isOwnMessage={false}
      />
    )
    expect(screen.getByTestId('stale-message')).toHaveTextContent('Stale error (resolved)')
  })

  // Timestamps
  it('shows timestamp on complete messages', () => {
    render(<ChatMessage message={makeMessage()} isOwnMessage={true} />)
    expect(screen.getByTestId('message-timestamp')).toBeInTheDocument()
  })

  it('shows relative time for recent messages', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    render(<ChatMessage message={makeMessage({ created_at: fiveMinAgo })} isOwnMessage={true} />)
    expect(screen.getByTestId('message-timestamp')).toHaveTextContent('5m ago')
  })

  it('shows absolute date for old messages', () => {
    render(<ChatMessage message={makeMessage({ created_at: '2026-01-15T22:30:00Z' })} isOwnMessage={false} />)
    const ts = screen.getByTestId('message-timestamp')
    // Should contain month and day
    expect(ts.textContent).toMatch(/Jan\s+15/)
  })

  it('does not show timestamp on pending messages', () => {
    render(
      <ChatMessage
        message={makeMessage({ status: 'pending', role: 'assistant', author_type: 'agent', content: '' })}
        isOwnMessage={false}
      />
    )
    expect(screen.queryByTestId('message-timestamp')).not.toBeInTheDocument()
  })

  it('stale message does not render red error styling', () => {
    const { container } = render(
      <ChatMessage
        message={makeMessage({
          author_type: 'agent',
          role: 'assistant',
          status: 'stale',
          error_message: 'token expired',
        })}
        isOwnMessage={false}
      />
    )
    // Should not have red error styling
    expect(container.querySelector('.text-red-400')).not.toBeInTheDocument()
  })
})
