'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Send, Monitor, Terminal, Activity, Globe, Users, Paperclip, Search, X } from 'lucide-react'
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
  const [fileToast, setFileToast] = useState(false)
  const [sessionPaneOpen, setSessionPaneOpen] = useState(false)
  const [activeSessionTab, setActiveSessionTab] = useState<'terminal' | 'events' | 'browser'>('terminal')
  const [participantPanelOpen, setParticipantPanelOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<(Message & { headline?: string })[]>([])
  const [searching, setSearching] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const refocusTimer = useRef<number | null>(null)

  const userId = (session.user as any)?.id || (session.user as any)?.sub || ''
  const isGroup = thread?.type === 'group'
  const agents = thread?.agents || (thread?.agent ? [thread.agent] : [])

  // Scroll to bottom on new messages
  const scrollToBottom = useCallback(() => {
    if (typeof messagesEndRef.current?.scrollIntoView === 'function') {
      // Use nearest to avoid scrolling the whole page
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
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
      if (refocusTimer.current) clearTimeout(refocusTimer.current)
    }
  }, [threadId])

  // Search handler with debounce
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!searchOpen || !searchQuery.trim()) {
      setSearchResults([])
      return
    }
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/chat/${threadId}/search?q=${encodeURIComponent(searchQuery.trim())}`)
        if (res.ok) {
          const data = await res.json()
          setSearchResults(data.results || [])
        }
      } catch {
        // ignore
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [searchQuery, searchOpen, threadId])

  // Focus search input when opened
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

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
      // Auto-refocus the input after sending
      refocusTimer.current = window.setTimeout(() => {
        const input = document.querySelector('[data-testid="mention-input"]') as HTMLTextAreaElement
        input?.focus()
      }, 50)
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
    <div className="flex h-full overflow-hidden">
      {/* Terminal (main stage) — shown when Live Session is open */}
      {sessionPaneOpen && (
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden border-r border-[#292e42] bg-[#1a1b26]">
          <SessionPane threadId={threadId} initialTab={activeSessionTab} />
        </div>
      )}

      {/* Chat column — full width when terminal closed, narrow sidebar when open */}
      <div className={`flex flex-col min-w-0 min-h-0 overflow-hidden ${sessionPaneOpen ? 'w-[340px] flex-shrink-0' : 'flex-1'}`}>
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
              <AgentStatusBar agents={agents} leadAgentId={thread?.lead_agent_id} />
            ) : (
              thread?.agent && (
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      thread.agent.status === 'running' ? 'bg-green-400 animate-pulse' : 'bg-red-400'
                    }`}
                    data-testid="agent-status-dot"
                  />
                  <span className="text-xs text-mountain-500">{agentName}</span>
                  <span className={`text-[10px] font-medium ${
                    thread.agent.status === 'running' ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {thread.agent.status === 'running' ? 'Running' : 'Stopped'}
                  </span>
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
              onClick={() => { setSearchOpen(prev => !prev); if (searchOpen) { setSearchQuery(''); setSearchResults([]) } }}
              className={`p-1.5 rounded transition-colors ${
                searchOpen
                  ? 'bg-brand-600/20 text-brand-400'
                  : 'text-mountain-400 hover:text-gray-200 hover:bg-navy-700'
              }`}
              title="Search messages"
              data-testid="search-toggle"
            >
              <Search size={18} />
            </button>
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
            <div className="flex items-center border-l border-navy-700 ml-1 pl-1 gap-0.5" data-testid="session-tabs">
              {([
                { key: 'terminal' as const, icon: Terminal, label: 'Terminal' },
                { key: 'browser' as const, icon: Globe, label: 'Browser' },
                { key: 'events' as const, icon: Activity, label: 'Events' },
              ]).map(({ key, icon: Icon, label }) => (
                <button
                  key={key}
                  onClick={() => {
                    if (activeSessionTab === key && sessionPaneOpen) {
                      setSessionPaneOpen(false)
                    } else {
                      setActiveSessionTab(key)
                      setSessionPaneOpen(true)
                    }
                  }}
                  className={`p-1.5 rounded transition-colors ${
                    sessionPaneOpen && activeSessionTab === key
                      ? 'bg-brand-600/20 text-brand-400'
                      : 'text-mountain-400 hover:text-gray-200 hover:bg-navy-700'
                  }`}
                  title={label}
                  data-testid={`session-tab-${key}`}
                >
                  <Icon size={16} />
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Search bar */}
        {searchOpen && (
          <div className="px-4 py-2 border-b border-navy-700 bg-navy-800/50" data-testid="search-bar">
            <div className="flex items-center gap-2">
              <Search size={14} className="text-mountain-500 flex-shrink-0" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search messages..."
                className="flex-1 bg-transparent text-sm text-white placeholder-mountain-500 focus:outline-none"
                data-testid="search-input"
              />
              {searching && (
                <div className="h-4 w-4 rounded-full border-2 border-brand-500 border-t-transparent animate-spin flex-shrink-0" />
              )}
              <button
                onClick={() => { setSearchOpen(false); setSearchQuery(''); setSearchResults([]) }}
                className="text-mountain-400 hover:text-white transition-colors"
              >
                <X size={14} />
              </button>
            </div>
            {searchResults.length > 0 && (
              <div className="mt-2 max-h-64 overflow-y-auto space-y-1" data-testid="search-results">
                {searchResults.map(r => (
                  <button
                    key={r.id}
                    onClick={() => {
                      const el = document.getElementById(`msg-${r.id}`)
                      if (el) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                        el.classList.add('ring-2', 'ring-brand-500/50')
                        setTimeout(() => el.classList.remove('ring-2', 'ring-brand-500/50'), 2000)
                      }
                    }}
                    className="w-full text-left px-3 py-2 rounded bg-navy-900/50 hover:bg-navy-700 transition-colors"
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[10px] font-medium text-mountain-500">
                        {r.author_type === 'human' ? 'You' : agents.find(a => a.id === r.author_id)?.name || 'Agent'}
                      </span>
                      <span className="text-[10px] text-mountain-600">
                        {new Date(r.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p
                      className="text-xs text-mountain-300 line-clamp-2"
                      dangerouslySetInnerHTML={{ __html: (r.headline || r.content.slice(0, 120)).replace(/\*\*([^*]+)\*\*/g, '<mark class="bg-brand-600/30 text-brand-300 rounded px-0.5">$1</mark>') }}
                    />
                  </button>
                ))}
              </div>
            )}
            {searchQuery.trim() && !searching && searchResults.length === 0 && (
              <p className="mt-2 text-xs text-mountain-500">No results found</p>
            )}
          </div>
        )}

        {/* Agent stopped warning */}
        {!anyAgentRunning && agents.length > 0 && (
          <div className="px-4 py-2 bg-yellow-900/20 border-b border-yellow-800/40 flex items-center gap-2" data-testid="agent-stopped-warning">
            <span className="w-2 h-2 rounded-full bg-red-400 flex-shrink-0" />
            <p className="text-xs text-yellow-300">
              {isGroup ? 'All agents are stopped.' : `${agentName} is stopped.`}
              {' '}Start the agent from the Agents page to resume chatting.
            </p>
          </div>
        )}

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
              <div key={msg.id} id={`msg-${msg.id}`} className="transition-all duration-300 rounded">
                <ChatMessage
                  message={msg}
                  isOwnMessage={msg.author_id === userId}
                  isGroup={isGroup}
                  agents={agents}
                  triggerAgentName={triggerAgentName}
                />
              </div>
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

        {/* File upload toast */}
        {fileToast && (
          <div className="px-4 py-2 bg-navy-800 border-t border-navy-700" data-testid="file-toast">
            <p className="text-sm text-mountain-400">File upload coming soon</p>
          </div>
        )}

        {/* Input */}
        <div className="px-4 py-3 border-t border-navy-700 bg-navy-900/50">
          <div className="flex gap-2 items-end">
            <button
              onClick={() => {
                setFileToast(true)
                setTimeout(() => setFileToast(false), 3000)
              }}
              className="p-2 text-mountain-400 hover:text-white hover:bg-navy-700 rounded-lg transition-colors flex-shrink-0"
              aria-label="Attach file"
              data-testid="attach-file-button"
            >
              <Paperclip size={18} />
            </button>
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
