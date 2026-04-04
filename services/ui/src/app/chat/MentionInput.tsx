'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import type { ChatAgent } from './ChatLayout'

interface Props {
  agents: ChatAgent[]
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled: boolean
  placeholder: string
}

export default function MentionInput({ agents, value, onChange, onSubmit, disabled, placeholder }: Props) {
  const [showAutocomplete, setShowAutocomplete] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [filterText, setFilterText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const filtered = agents.filter(a =>
    a.agent_id.toLowerCase().startsWith(filterText.toLowerCase())
  )

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [filterText])

  const insertMention = useCallback((agent: ChatAgent) => {
    const textarea = textareaRef.current
    if (!textarea) return

    // Find the @ that triggered autocomplete and replace @prefix with @slug
    const beforeCursor = value.slice(0, textarea.selectionStart)
    const atIndex = beforeCursor.lastIndexOf('@')
    if (atIndex === -1) return

    const before = value.slice(0, atIndex)
    const after = value.slice(textarea.selectionStart)
    const newValue = `${before}@${agent.agent_id} ${after}`
    onChange(newValue)
    setShowAutocomplete(false)
    setFilterText('')

    // Focus back and set cursor after inserted mention
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const pos = before.length + agent.agent_id.length + 2 // @slug + space
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(pos, pos)
      }
    })
  }, [value, onChange])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    onChange(newValue)

    // Check if we should show autocomplete — use ref for cursor position (more reliable in tests)
    const cursorPos = textareaRef.current?.selectionStart ?? newValue.length
    const textBeforeCursor = newValue.slice(0, cursorPos)
    const atMatch = textBeforeCursor.match(/@([a-z0-9-]*)$/)

    if (atMatch) {
      setShowAutocomplete(true)
      setFilterText(atMatch[1])
    } else {
      setShowAutocomplete(false)
      setFilterText('')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showAutocomplete && filtered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(prev => (prev + 1) % filtered.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(prev => (prev - 1 + filtered.length) % filtered.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(filtered[selectedIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowAutocomplete(false)
        return
      }
    }

    // Normal Enter (no autocomplete): submit
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSubmit()
    }
  }

  return (
    <div className="relative flex-1">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        data-testid="mention-input"
        className="w-full bg-navy-800 border border-navy-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-mountain-500 focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none disabled:opacity-50"
      />

      {showAutocomplete && filtered.length > 0 && (
        <div
          className="absolute bottom-full left-0 mb-1 w-64 bg-navy-800 border border-navy-700 rounded-lg shadow-lg overflow-hidden z-50"
          data-testid="mention-autocomplete"
        >
          {filtered.map((agent, i) => (
            <button
              key={agent.id}
              onClick={() => insertMention(agent)}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                i === selectedIndex
                  ? 'bg-brand-600/20 text-white'
                  : 'text-mountain-300 hover:bg-navy-700'
              }`}
              data-testid="mention-option"
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  agent.status === 'running' ? 'bg-brand-400' : 'bg-mountain-500'
                }`}
              />
              <span className="font-medium">@{agent.agent_id}</span>
              <span className="text-mountain-500 text-xs truncate">{agent.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
