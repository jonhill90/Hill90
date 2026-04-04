import React, { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import MentionInput from '@/app/chat/MentionInput'
import type { ChatAgent } from '@/app/chat/ChatLayout'

const MOCK_AGENTS: ChatAgent[] = [
  { id: 'a1', agent_id: 'research-bot', name: 'ResearchBot', status: 'running' },
  { id: 'a2', agent_id: 'writer-bot', name: 'WriterBot', status: 'running' },
  { id: 'a3', agent_id: 'review-bot', name: 'ReviewBot', status: 'stopped' },
]

// Stateful wrapper that mirrors real usage (controlled input)
function MentionWrapper({
  agents = MOCK_AGENTS,
  onSubmit = vi.fn(),
  initialValue = '',
}: {
  agents?: ChatAgent[]
  onSubmit?: () => void
  initialValue?: string
}) {
  const [value, setValue] = useState(initialValue)
  return (
    <MentionInput
      agents={agents}
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      disabled={false}
      placeholder="Message..."
    />
  )
}

// Helper: type into the mention input by setting value + selectionStart on the textarea ref
function typeInto(textarea: HTMLTextAreaElement, text: string) {
  // Set selectionStart before firing change so the ref reads it
  Object.defineProperty(textarea, 'selectionStart', { value: text.length, writable: true, configurable: true })
  fireEvent.change(textarea, { target: { value: text } })
}

describe('MentionInput', () => {
  afterEach(() => cleanup())

  it('T1: shows autocomplete on @ trigger', () => {
    render(<MentionWrapper />)

    const textarea = screen.getByTestId('mention-input') as HTMLTextAreaElement
    typeInto(textarea, '@')

    expect(screen.getByTestId('mention-autocomplete')).toBeInTheDocument()
    expect(screen.getAllByTestId('mention-option')).toHaveLength(3)
  })

  it('T2: inserts @slug on selection', () => {
    render(<MentionWrapper />)

    const textarea = screen.getByTestId('mention-input') as HTMLTextAreaElement
    typeInto(textarea, 'Hello @')

    const options = screen.getAllByTestId('mention-option')
    fireEvent.click(options[0])

    // After clicking research-bot, the input should contain @research-bot
    expect(textarea.value).toContain('@research-bot')
    // Autocomplete should close
    expect(screen.queryByTestId('mention-autocomplete')).not.toBeInTheDocument()
  })

  it('T3: filters agents by prefix after @', () => {
    render(<MentionWrapper />)

    const textarea = screen.getByTestId('mention-input') as HTMLTextAreaElement
    typeInto(textarea, '@wr')

    // Only writer-bot matches "wr" prefix
    const options = screen.getAllByTestId('mention-option')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('@writer-bot')
  })

  it('T4: closes autocomplete on Escape', () => {
    render(<MentionWrapper />)

    const textarea = screen.getByTestId('mention-input') as HTMLTextAreaElement
    typeInto(textarea, '@')

    expect(screen.getByTestId('mention-autocomplete')).toBeInTheDocument()

    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(screen.queryByTestId('mention-autocomplete')).not.toBeInTheDocument()
  })

  it('T5: submits message with @mention intact', () => {
    const onSubmit = vi.fn()
    render(<MentionWrapper onSubmit={onSubmit} initialValue="@research-bot what is TypeScript?" />)

    const textarea = screen.getByTestId('mention-input')
    // Enter without autocomplete open should submit
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})
