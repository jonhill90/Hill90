'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Send } from 'lucide-react'
import type { Session } from 'next-auth'
import type { ChatThread } from './ChatLayout'
import ChatMessage from './ChatMessage'

export interface Message {
  id: string
  seq: number
  thread_id: string
  author_id: string
  author_type: 'human' | 'agent'
  role: 'user' | 'assistant'
  content: string
  status: 'pending' | 'complete' | 'error'
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  duration_ms: number | null
  error_message: string | null
  created_at: string
}

interface Props {
  threadId: string
  session: Session
  thread?: ChatThread
  onBack: () => void
  onThreadUpdated: () => void
}

export default function ChatView({ threadId, session, thread, onBack, onThreadUpdated }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  const userId = (session.user as any)?.id || (session.user as any)?.sub || ''

  // Scroll to bottom on new messages
  const scrollToBottom = useCallback(() => {
    if (typeof messagesEndRef.current?.scrollIntoView === 'function') {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  // SSE connection
  useEffect(() => {
    const es = new EventSource(`/api/chat/${threadId}/stream`)
    eventSourceRef.current = es

    es.addEventListener('message', (e) => {
      const msg: Message = JSON.parse(e.data)
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === msg.id)
        if (idx >= 0) {
          // Update existing message (status transition)
          const next = [...prev]
          next[idx] = msg
          return next
        }
        // New message — append
        return [...prev, msg]
      })
    })

    es.addEventListener('heartbeat', () => {
      // Keep-alive — no action needed
    })

    es.onerror = () => {
      // EventSource auto-reconnects with Last-Event-ID
    }

    return () => {
      es.close()
      eventSourceRef.current = null
    }
  }, [threadId])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || sending) return

    setSending(true)
    setError(null)
    setInput('')

    try {
      const res = await fetch(`/api/chat/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })

      if (!res.ok) {
        const data = await res.json()
        setError(data.error || data.detail || `Error: ${res.status}`)
        setInput(text) // Restore input on error
      } else {
        onThreadUpdated()
      }
    } catch {
      setError('Failed to send message')
      setInput(text)
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const hasPending = messages.some(m => m.status === 'pending')
  const agentName = thread?.agent?.name || 'Agent'
  const agentStatus = thread?.agent?.status

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-navy-700 bg-navy-900/50">
        <button
          onClick={onBack}
          className="lg:hidden text-mountain-400 hover:text-gray-200 transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-sm font-semibold text-gray-200 truncate">
            {thread?.title || agentName}
          </h2>
          {agentStatus && (
            <span
              className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                agentStatus === 'running' ? 'bg-brand-400' : 'bg-mountain-500'
              }`}
            />
          )}
          <span className="text-xs text-mountain-500">{agentName}</span>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-mountain-400 text-sm">
            Send a message to begin the conversation.
          </div>
        )}
        {messages.map(msg => (
          <ChatMessage key={msg.id} message={msg} isOwnMessage={msg.author_id === userId} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-2 bg-red-900/30 border-t border-red-800">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Input */}
      <div className="px-4 py-3 border-t border-navy-700 bg-navy-900/50">
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              agentStatus !== 'running'
                ? 'Agent is not running'
                : hasPending
                ? 'Waiting for response...'
                : 'Type a message...'
            }
            disabled={sending || agentStatus !== 'running'}
            rows={1}
            className="flex-1 bg-navy-800 border border-navy-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-mountain-500 focus:outline-none focus:ring-1 focus:ring-brand-500 resize-none disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending || agentStatus !== 'running'}
            className="p-2 bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}
