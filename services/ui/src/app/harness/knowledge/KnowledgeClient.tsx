'use client'

import { useState, useEffect, useCallback } from 'react'

interface KnowledgeAgent {
  agent_id: string
  entry_count: number
  last_updated: string
}

interface KnowledgeEntry {
  id: string
  agent_id: string
  path: string
  title: string
  entry_type: string
  tags: string[]
  status: string
  created_at: string
  updated_at: string
}

interface KnowledgeEntryFull extends KnowledgeEntry {
  content: string
}

interface SearchResult {
  id: string
  agent_id: string
  path: string
  title: string
  entry_type: string
  tags: string[]
  score: number
  headline: string
  created_at: string
  updated_at: string
}

interface Agent {
  id: string
  name: string
  agent_id: string
}

const ENTRY_TYPES = ['note', 'plan', 'decision', 'journal', 'research'] as const

function typeBadgeColor(type: string): string {
  switch (type) {
    case 'plan': return 'bg-blue-900/40 text-blue-400 border-blue-700'
    case 'decision': return 'bg-purple-900/40 text-purple-400 border-purple-700'
    case 'journal': return 'bg-amber-900/40 text-amber-400 border-amber-700'
    case 'research': return 'bg-cyan-900/40 text-cyan-400 border-cyan-700'
    case 'note':
    default: return 'bg-navy-700/50 text-mountain-300 border-navy-600'
  }
}

export default function KnowledgeClient() {
  const [knowledgeAgents, setKnowledgeAgents] = useState<KnowledgeAgent[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [entries, setEntries] = useState<KnowledgeEntry[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [selectedEntry, setSelectedEntry] = useState<KnowledgeEntryFull | null>(null)
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [loading, setLoading] = useState(true)
  const [entriesLoading, setEntriesLoading] = useState(false)
  const [contentLoading, setContentLoading] = useState(false)

  const agentName = useCallback((agentId: string) =>
    agents.find((a) => a.id === agentId || a.agent_id === agentId)?.name ?? agentId.substring(0, 8),
  [agents])

  const fetchInitialData = useCallback(async () => {
    try {
      const [kaRes, agentsRes] = await Promise.all([
        fetch('/api/knowledge/agents'),
        fetch('/api/agents'),
      ])
      if (kaRes.ok) setKnowledgeAgents(await kaRes.json())
      if (agentsRes.ok) setAgents(await agentsRes.json())
    } catch (err) {
      console.error('Failed to fetch knowledge data:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchInitialData()
  }, [fetchInitialData])

  const fetchEntries = useCallback(async (agentId: string) => {
    setEntriesLoading(true)
    setSelectedEntry(null)
    try {
      const params = new URLSearchParams({ agent_id: agentId })
      if (typeFilter) params.set('type', typeFilter)
      const res = await fetch(`/api/knowledge/entries?${params}`)
      if (res.ok) setEntries(await res.json())
    } catch (err) {
      console.error('Failed to fetch entries:', err)
    } finally {
      setEntriesLoading(false)
    }
  }, [typeFilter])

  useEffect(() => {
    if (selectedAgent) {
      fetchEntries(selectedAgent)
    }
  }, [selectedAgent, fetchEntries])

  const fetchContent = async (entry: KnowledgeEntry) => {
    setContentLoading(true)
    try {
      const res = await fetch(`/api/knowledge/entries/${entry.agent_id}/${entry.path}`)
      if (res.ok) {
        const full: KnowledgeEntryFull = await res.json()
        setSelectedEntry(full)
      }
    } catch (err) {
      console.error('Failed to fetch entry content:', err)
    } finally {
      setContentLoading(false)
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setIsSearching(false)
      setSearchResults([])
      return
    }
    setIsSearching(true)
    try {
      const params = new URLSearchParams({ q: searchQuery.trim() })
      if (selectedAgent) params.set('agent_id', selectedAgent)
      const res = await fetch(`/api/knowledge/search?${params}`)
      if (res.ok) {
        const data = await res.json()
        setSearchResults(data.results || [])
      }
    } catch (err) {
      console.error('Failed to search knowledge:', err)
    }
  }

  const clearSearch = () => {
    setSearchQuery('')
    setIsSearching(false)
    setSearchResults([])
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Agent Knowledge</h1>
        <p className="text-sm text-mountain-400 mt-1">
          Browse and search what your agents have learned.
        </p>
      </div>

      {/* Search bar */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-4 mb-6">
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search across all knowledge entries..."
            className="flex-1 rounded-md border border-navy-600 bg-navy-900 px-3 py-1.5 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
          />
          <button
            onClick={handleSearch}
            className="px-4 py-1.5 text-sm font-medium rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
          >
            Search
          </button>
          {isSearching && (
            <button
              onClick={clearSearch}
              className="px-3 py-1.5 text-sm font-medium rounded-md border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Search results */}
      {isSearching ? (
        <div>
          <p className="text-sm text-mountain-400 mb-4">
            {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} for &ldquo;{searchQuery}&rdquo;
          </p>
          {searchResults.length === 0 ? (
            <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
              <p className="text-mountain-400">No results found</p>
            </div>
          ) : (
            <div className="space-y-3">
              {searchResults.map((result) => (
                <div key={result.id} className="rounded-lg border border-navy-700 bg-navy-800 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-white font-medium">{result.title}</span>
                        <span className={`px-1.5 py-0.5 text-xs rounded border ${typeBadgeColor(result.entry_type)}`}>
                          {result.entry_type}
                        </span>
                      </div>
                      <p className="text-xs text-mountain-500 mb-2">
                        {agentName(result.agent_id)} &middot; {result.path}
                      </p>
                      {result.headline && (
                        <p className="text-sm text-mountain-300"
                          dangerouslySetInnerHTML={{ __html: result.headline }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* Two-panel layout */
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Left panel: Agent list */}
          <div className="lg:col-span-1">
            <h2 className="text-sm font-medium text-mountain-400 mb-3">Agents</h2>
            {knowledgeAgents.length === 0 ? (
              <div className="rounded-lg border border-navy-700 bg-navy-800 p-6 text-center">
                <p className="text-sm text-mountain-500">No agents with knowledge entries yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {knowledgeAgents.map((ka) => (
                  <button
                    key={ka.agent_id}
                    onClick={() => { setSelectedAgent(ka.agent_id); clearSearch() }}
                    className={`w-full text-left rounded-lg border p-3 transition-colors cursor-pointer ${
                      selectedAgent === ka.agent_id
                        ? 'bg-brand-900/30 border-brand-700 text-white'
                        : 'bg-navy-800 border-navy-700 text-mountain-300 hover:border-navy-500'
                    }`}
                  >
                    <div className="font-medium text-sm">{agentName(ka.agent_id)}</div>
                    <div className="text-xs text-mountain-500 mt-1">
                      {ka.entry_count} entr{ka.entry_count !== 1 ? 'ies' : 'y'}
                      {ka.last_updated && (
                        <> &middot; {new Date(ka.last_updated).toLocaleDateString()}</>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Right panel: Entry list + content */}
          <div className="lg:col-span-3">
            {!selectedAgent ? (
              <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
                <p className="text-mountain-400 mb-2">Select an agent to browse knowledge</p>
                <p className="text-sm text-mountain-500">
                  Agents build persistent memory across sessions — plans, decisions, journals, research, and notes.
                </p>
              </div>
            ) : (
              <>
                {/* Type filter */}
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-sm text-mountain-400">Type:</span>
                  <button
                    onClick={() => setTypeFilter('')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                      typeFilter === ''
                        ? 'bg-brand-900/50 text-brand-400 border-brand-700'
                        : 'bg-navy-900 text-mountain-400 border-navy-700 hover:border-navy-500'
                    }`}
                  >
                    All
                  </button>
                  {ENTRY_TYPES.map((type) => (
                    <button
                      key={type}
                      onClick={() => setTypeFilter(type)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
                        typeFilter === type
                          ? 'bg-brand-900/50 text-brand-400 border-brand-700'
                          : 'bg-navy-900 text-mountain-400 border-navy-700 hover:border-navy-500'
                      }`}
                    >
                      {type}
                    </button>
                  ))}
                </div>

                {entriesLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
                  </div>
                ) : entries.length === 0 ? (
                  <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
                    <p className="text-mountain-400">No entries found</p>
                    {typeFilter && (
                      <p className="text-sm text-mountain-500 mt-1">
                        Try clearing the type filter.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4">
                    {/* Entry list */}
                    <div className="rounded-lg border border-navy-700 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-navy-800 text-mountain-400 text-left">
                            <th className="px-4 py-3 font-medium">Title</th>
                            <th className="px-4 py-3 font-medium">Type</th>
                            <th className="px-4 py-3 font-medium">Updated</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-navy-700">
                          {entries.map((entry) => (
                            <tr
                              key={entry.id}
                              onClick={() => fetchContent(entry)}
                              className={`cursor-pointer transition-colors ${
                                selectedEntry?.id === entry.id
                                  ? 'bg-brand-900/20'
                                  : 'bg-navy-900 hover:bg-navy-800'
                              }`}
                            >
                              <td className="px-4 py-3 text-white">{entry.title}</td>
                              <td className="px-4 py-3">
                                <span className={`px-1.5 py-0.5 text-xs rounded border ${typeBadgeColor(entry.entry_type)}`}>
                                  {entry.entry_type}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-mountain-400">
                                {new Date(entry.updated_at).toLocaleDateString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Content view */}
                    {contentLoading ? (
                      <div className="flex items-center justify-center py-12">
                        <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
                      </div>
                    ) : selectedEntry ? (
                      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
                        <div className="flex items-center gap-2 mb-4">
                          <h3 className="text-lg font-semibold text-white">{selectedEntry.title}</h3>
                          <span className={`px-1.5 py-0.5 text-xs rounded border ${typeBadgeColor(selectedEntry.entry_type)}`}>
                            {selectedEntry.entry_type}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-mountain-500 mb-4">
                          <span>{selectedEntry.path}</span>
                          <span>&middot;</span>
                          <span>{new Date(selectedEntry.updated_at).toLocaleDateString()}</span>
                          {selectedEntry.tags.length > 0 && (
                            <>
                              <span>&middot;</span>
                              <span>{selectedEntry.tags.join(', ')}</span>
                            </>
                          )}
                        </div>
                        <pre className="whitespace-pre-wrap text-sm text-mountain-200 bg-navy-900 rounded-lg p-4 overflow-auto max-h-[600px] border border-navy-700">
                          {selectedEntry.content}
                        </pre>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-navy-700 bg-navy-800 p-8 text-center">
                        <p className="text-sm text-mountain-500">Click an entry to view its content.</p>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
