'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Send, Terminal, Users } from 'lucide-react'
import type { Session } from 'next-auth'
import type { ChatThread } from './ChatLayout'
import ChatMessage from './ChatMessage'
import AgentStatusBar from './AgentStatusBar'
import CancelButton from './CancelButton'
import SessionPane from './SessionPane'
import MentionInput from './MentionInput'
import ParticipantPanel from './ParticipantPanel'

export interface Message {
  id: string
  seq: number
  thread_id: string
  author_id: string
  author_type: 'human' | 'agent'
  role: 'user' | 'assistant'
  content: string
  status: 'pending' | 'complete' | 'error' | 'stale'
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  duration_ms: number | null
  error_message: string | null
  reply_to: string | null
  chain_id: string | null
  chain_hop: number | null
  triggered_by: string | null
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
  const [sessionPaneOpen, setSessionPaneOpen] = useState(false)
  const [participantPanelOpen, setParticipantPanelOpen] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

  const userId = (session.user as any)?.id || (session.user as any)?.sub || ''
  const isGroup = thread?.type === 'group'
  const agents = thread?.agents || (thread?.agent ? [thread.agent] : [])

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

  const hasPending = messages.some(m => m.status === 'pending')
  const anyAgentRunning = agents.some(a => a.status === 'running')
  const agentName = thread?.agent?.name || 'Agent'

  // Build placeholder text for input
  const getPlaceholder = () => {
    if (!anyAgentRunning) return 'No agents running'
    if (hasPending) return 'Waiting for response...'
    if (isGroup) return 'Message all agents, or @name to target one...'
    return 'Type a message...'
  }

  return (
    <div className="flex h-full">
      {/* Terminal (main stage) — shown when Live Session is open */}
      {sessionPaneOpen && (
        <div className="flex-1 flex flex-col min-w-0 border-r border-navy-700 bg-[#0d1117]">
          <SessionPane threadId={threadId} />
        </div>
      )}

      {/* Chat column — full width when terminal closed, sidebar when open */}
      <div className={`flex flex-col min-w-0 ${sessionPaneOpen ? 'w-[400px] flex-shrink-0' : 'flex-1'}`}>
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-navy-700 bg-navy-900/50">
          <button
            onClick={onBack}
            className="lg:hidden text-mountain-400 hover:text-gray-200 transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-gray-200 truncate">
                {thread?.title || agentName}
              </h2>
              {isGroup && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-navy-700 text-mountain-300 rounded">
                  Group
                </span>
              )}
            </div>
            {isGroup ? (
              <AgentStatusBar agents={agents} />
            ) : (
              thread?.agent && (
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      thread.agent.status === 'running' ? 'bg-brand-400' : 'bg-mountain-500'
                    }`}
                  />
                  <span className="text-xs text-mountain-500">{agentName}</span>
                </div>
              )
            )}
          </div>
          <div className="flex items-center gap-1">
            <CancelButton
              threadId={threadId}
              hasPending={hasPending}
              onCancelled={onThreadUpdated}
            />
            <button
              onClick={() => setParticipantPanelOpen(prev => !prev)}
              className={`p-1.5 rounded transition-colors ${
                participantPanelOpen
                  ? 'bg-brand-600/20 text-brand-400'
                  : 'text-mountain-400 hover:text-gray-200 hover:bg-navy-700'
              }`}
              title="Manage Participants"
              data-testid="participants-toggle"
            >
              <Users size={18} />
            </button>
            <button
              onClick={() => setSessionPaneOpen(prev => !prev)}
              className={`p-1.5 rounded transition-colors ${
                sessionPaneOpen
                  ? 'bg-brand-600/20 text-brand-400'
                  : 'text-mountain-400 hover:text-gray-200 hover:bg-navy-700'
              }`}
              title="Toggle Live Session"
              data-testid="session-toggle"
            >
              <Terminal size={18} />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full text-mountain-400 text-sm">
              Send a message to begin the conversation.
            </div>
          )}
          {messages.map(msg => {
            // Compute trigger agent name for chain provenance
            let triggerAgentName: string | undefined
            if (msg.triggered_by) {
              const triggerMsg = messages.find(m => m.id === msg.triggered_by)
              if (triggerMsg) {
                triggerAgentName = agents.find(a => a.id === triggerMsg.author_id)?.name
              }
            }
            return (
              <ChatMessage
                key={msg.id}
                message={msg}
                isOwnMessage={msg.author_id === userId}
                isGroup={isGroup}
                agents={agents}
                triggerAgentName={triggerAgentName}
              />
            )
          })}
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
            <MentionInput
              agents={agents}
              value={input}
              onChange={setInput}
              onSubmit={handleSend}
              disabled={sending || !anyAgentRunning}
              placeholder={getPlaceholder()}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || sending || !anyAgentRunning}
              className="p-2 bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      </div>

      {/* Participant panel — overlay on small screens, side-panel on xl+ */}
      {participantPanelOpen && (
        <>
          {/* Backdrop (below xl) */}
          <div
            className="fixed inset-0 bg-black/40 z-40 xl:hidden"
            onClick={() => setParticipantPanelOpen(false)}
          />
          <div className="fixed right-0 top-0 bottom-0 w-[300px] z-50 xl:relative xl:z-auto flex-shrink-0 border-l border-navy-700 bg-navy-900">
            <ParticipantPanel
              threadId={threadId}
              currentAgents={agents}
              onUpdated={onThreadUpdated}
              onClose={() => setParticipantPanelOpen(false)}
            />
          </div>
        </>
      )}

    </div>
  )
}
