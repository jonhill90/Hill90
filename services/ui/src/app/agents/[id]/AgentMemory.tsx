'use client'

import React, { useState, useEffect, useCallback } from 'react'

const ENTRY_TYPES = ['note', 'plan', 'decision', 'journal', 'research'] as const
type EntryType = typeof ENTRY_TYPES[number]
type TypeFilter = 'all' | EntryType

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

function renderHeadline(text: string): React.ReactNode {
  const parts = text.split('**')
  return parts.map((part, i) =>
    i % 2 === 1
      ? React.createElement('strong', { key: i, className: 'text-white' }, part)
      : part
  )
}

interface Entry {
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

interface SearchResult extends Entry {
  score: number
  headline: string
}

interface Props {
  agentId: string
}

export default function AgentMemory({ agentId }: Props) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null)
  const [selectedContent, setSelectedContent] = useState<string | null>(null)
  const [contentLoading, setContentLoading] = useState(false)

  const fetchEntries = useCallback(async () => {
    try {
      const res = await fetch(`/api/knowledge/entries?agent_id=${agentId}`)
      if (res.ok) {
        const data = await res.json()
        setEntries(Array.isArray(data) ? data : [])
      }
    } catch {
      // Non-fatal
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    fetchEntries()
  }, [fetchEntries])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (!search.trim()) return
    setSearchLoading(true)
    fetch(`/api/knowledge/search?q=${encodeURIComponent(search.trim())}&agent_id=${agentId}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.results) setSearchResults(data.results)
        else setSearchResults([])
      })
      .catch(() => setSearchResults([]))
      .finally(() => setSearchLoading(false))
  }

  const loadEntryContent = (entry: Entry) => {
    setSelectedEntry(entry)
    setContentLoading(true)
    fetch(`/api/knowledge/entries/${agentId}/${entry.path}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => setSelectedContent(data?.content ?? null))
      .catch(() => setSelectedContent(null))
      .finally(() => setContentLoading(false))
  }

  // Filter entries by type
  const filtered = typeFilter === 'all'
    ? entries
    : entries.filter(e => e.entry_type === typeFilter)

  // Compute counts
  const typeCounts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.entry_type] = (acc[e.entry_type] || 0) + 1
    return acc
  }, {})

  // Entry detail view
  if (selectedEntry) {
    return (
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
        <div className="mb-3">
          <button
            onClick={() => { setSelectedEntry(null); setSelectedContent(null) }}
            className="text-sm text-brand-400 hover:text-brand-300 transition-colors cursor-pointer"
            data-testid="back-to-list"
          >
            Back to list
          </button>
        </div>
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-white">{selectedEntry.title || selectedEntry.path}</h2>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs font-mono text-mountain-400">{selectedEntry.path}</span>
            <span className={`px-1.5 py-0.5 text-xs rounded-md border ${typeBadgeColor(selectedEntry.entry_type)}`}>
              {selectedEntry.entry_type}
            </span>
          </div>
        </div>
        {contentLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
          </div>
        ) : selectedContent !== null ? (
          <pre className="text-sm text-mountain-300 whitespace-pre-wrap bg-navy-900 rounded-md p-4 max-h-96 overflow-auto" data-testid="entry-content">
            {selectedContent}
          </pre>
        ) : (
          <p className="text-sm text-mountain-500">Failed to load entry content</p>
        )}
      </div>
    )
  }

  // List / search view
  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-white">Memory</h2>
        {entries.length > 0 && (
          <p className="text-xs text-mountain-400 mt-1" data-testid="entry-count-summary">
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
            {Object.keys(typeCounts).length > 0 && (
              <span>
                {' '}({Object.entries(typeCounts).map(([type, count], i) => (
                  <span key={type}>{i > 0 ? ', ' : ''}{count} {type}</span>
                ))})
              </span>
            )}
          </p>
        )}
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <input
          type="text"
          value={search}
          onChange={e => {
            setSearch(e.target.value)
            if (!e.target.value.trim()) setSearchResults(null)
          }}
          placeholder="Search memory entries..."
          className="flex-1 rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:outline-none focus:border-brand-500"
        />
        <button
          type="submit"
          disabled={searchLoading || !search.trim()}
          className="px-4 py-2 text-sm font-medium rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
        >
          Search
        </button>
      </form>

      {/* Type filter tabs */}
      <div className="flex items-center gap-1 mb-4" data-testid="type-filters">
        <button
          onClick={() => setTypeFilter('all')}
          className={`px-2 py-1 text-xs rounded-md transition-colors cursor-pointer ${
            typeFilter === 'all' ? 'bg-brand-600 text-white' : 'text-mountain-400 hover:text-white hover:bg-navy-700'
          }`}
        >
          All
        </button>
        {ENTRY_TYPES.map(type => (
          <button
            key={type}
            onClick={() => setTypeFilter(type)}
            className={`px-2 py-1 text-xs rounded-md transition-colors cursor-pointer ${
              typeFilter === type ? 'bg-brand-600 text-white' : 'text-mountain-400 hover:text-white hover:bg-navy-700'
            }`}
          >
            {type}
          </button>
        ))}
      </div>

      {searchResults !== null ? (
        /* Search results */
        <div>
          {searchLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
            </div>
          ) : searchResults.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-mountain-400 mb-2">{searchResults.length} results</p>
              {searchResults.map(result => (
                <button
                  key={result.id || result.path}
                  onClick={() => loadEntryContent(result)}
                  className="w-full text-left rounded-md border border-navy-700 bg-navy-900 p-3 hover:border-navy-500 transition-colors cursor-pointer"
                  data-testid="search-result"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-white">{result.title || result.path}</span>
                    <span className={`px-1.5 py-0.5 text-xs rounded-md border ${typeBadgeColor(result.entry_type)}`}>
                      {result.entry_type}
                    </span>
                    {result.score != null && (
                      <span className="text-xs text-mountain-500">score: {Number(result.score).toFixed(2)}</span>
                    )}
                  </div>
                  {result.headline && (
                    <p className="text-xs text-mountain-300">{renderHeadline(result.headline)}</p>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-mountain-500">No results found</p>
          )}
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
        </div>
      ) : filtered.length > 0 ? (
        /* Entry list */
        <div className="space-y-2" data-testid="entry-list">
          {filtered.map(entry => (
            <button
              key={entry.id}
              onClick={() => loadEntryContent(entry)}
              className="w-full text-left rounded-md border border-navy-700 bg-navy-900 p-3 hover:border-navy-500 transition-colors cursor-pointer"
              data-testid="entry-item"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-white">{entry.title || entry.path}</span>
                <span className={`px-1.5 py-0.5 text-xs rounded-md border ${typeBadgeColor(entry.entry_type)}`}>
                  {entry.entry_type}
                </span>
              </div>
              <p className="text-xs font-mono text-mountain-400">{entry.path}</p>
              <p className="text-xs text-mountain-500 mt-1">
                {new Date(entry.created_at).toLocaleString()}
              </p>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-mountain-500" data-testid="empty-state">
          No memory entries yet. This agent hasn&apos;t created any knowledge.
        </p>
      )}
    </div>
  )
}
