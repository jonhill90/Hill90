'use client'

import { useState, useEffect, useCallback } from 'react'
import { Search, BookOpen, FileText, Plus, X } from 'lucide-react'

interface Collection {
  id: string
  name: string
  description: string | null
  visibility: string
  source_count?: number
  created_at: string
}

interface SearchResult {
  chunk_id: string
  content: string
  headline: string
  rank: number
  source_title: string
  collection_name: string
}

export default function AgentKnowledge({ agentName, agentId }: { agentName: string; agentId: string }) {
  const [collections, setCollections] = useState<Collection[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<SearchResult[]>([])
  const [searched, setSearched] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [newContent, setNewContent] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const fetchCollections = useCallback(async () => {
    try {
      const res = await fetch('/api/shared-knowledge/collections')
      if (res.ok) {
        setCollections(await res.json())
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCollections()
  }, [fetchCollections])

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return

    setSearching(true)
    setSearched(true)
    try {
      const params = new URLSearchParams({ q: query.trim() })
      const res = await fetch(`/api/shared-knowledge/search?${params}`)
      if (res.ok) {
        const data = await res.json()
        setResults(data.results || [])
      }
    } catch {
      // silent
    } finally {
      setSearching(false)
    }
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newPath.trim() || !newContent.trim()) return

    setCreating(true)
    setCreateError(null)
    try {
      const res = await fetch('/api/knowledge/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, path: newPath.trim(), content: newContent.trim() }),
      })
      if (res.ok) {
        setShowCreate(false)
        setNewPath('')
        setNewContent('')
      } else {
        const data = await res.json()
        setCreateError(data.error || data.detail || 'Failed to create entry')
      }
    } catch {
      setCreateError('Failed to create entry')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Create entry toggle */}
      <div className="flex justify-end">
        <button
          onClick={() => setShowCreate(prev => !prev)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
        >
          {showCreate ? <X size={14} /> : <Plus size={14} />}
          {showCreate ? 'Cancel' : 'New Entry'}
        </button>
      </div>

      {/* Create entry form */}
      {showCreate && (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
          <h2 className="text-lg font-semibold text-white mb-3">Create Knowledge Entry</h2>
          <form onSubmit={handleCreate} className="space-y-3">
            <div>
              <label className="block text-xs text-mountain-400 mb-1">Path</label>
              <input
                type="text"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="notes/my-entry.md"
                className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                data-testid="create-path-input"
              />
            </div>
            <div>
              <label className="block text-xs text-mountain-400 mb-1">Content</label>
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder={"---\ntitle: My Entry\ntype: note\n---\n\nEntry content here..."}
                rows={8}
                className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none font-mono resize-y"
                data-testid="create-content-input"
              />
              <p className="text-xs text-mountain-500 mt-1">Include YAML frontmatter with title, type (note/plan/decision/journal/research), and optional tags.</p>
            </div>
            {createError && (
              <p className="text-sm text-red-400">{createError}</p>
            )}
            <button
              type="submit"
              disabled={!newPath.trim() || !newContent.trim() || creating}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? 'Creating...' : 'Create Entry'}
            </button>
          </form>
        </div>
      )}

      {/* Search */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
        <h2 className="text-lg font-semibold text-white mb-3">Search Knowledge</h2>
        <p className="text-xs text-mountain-500 mb-3">
          Search across shared knowledge collections available to {agentName}.
        </p>
        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-mountain-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search shared knowledge..."
              className="w-full pl-9 pr-3 py-2 rounded-md border border-navy-600 bg-navy-900 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
              data-testid="knowledge-search-input"
            />
          </div>
          <button
            type="submit"
            disabled={!query.trim() || searching}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {searching ? 'Searching...' : 'Search'}
          </button>
        </form>

        {searched && !searching && (
          <div className="mt-4" data-testid="search-results">
            {results.length === 0 ? (
              <p className="text-sm text-mountain-500">No results found.</p>
            ) : (
              <div className="space-y-3">
                {results.map((r) => (
                  <div key={r.chunk_id} className="rounded-md border border-navy-700 bg-navy-900 p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <FileText size={12} className="text-mountain-400" />
                      <span className="text-xs font-medium text-mountain-400">{r.collection_name}</span>
                      <span className="text-xs text-mountain-500">{r.source_title}</span>
                    </div>
                    <p
                      className="text-sm text-gray-200"
                      dangerouslySetInnerHTML={{ __html: r.headline || r.content.slice(0, 200) }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Collections */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
        <h2 className="text-lg font-semibold text-white mb-3">Available Collections</h2>
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <div className="h-5 w-5 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
          </div>
        ) : collections.length === 0 ? (
          <p className="text-sm text-mountain-500" data-testid="no-collections">
            No shared knowledge collections available.
          </p>
        ) : (
          <div className="space-y-2" data-testid="collections-list">
            {collections.map((col) => (
              <div key={col.id} className="flex items-start gap-3 rounded-md border border-navy-700 bg-navy-900 p-3">
                <BookOpen size={16} className="text-brand-400 mt-0.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white">{col.name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                      col.visibility === 'shared'
                        ? 'bg-brand-900/50 text-brand-400 border-brand-700'
                        : 'bg-navy-700 text-mountain-400 border-navy-600'
                    }`}>
                      {col.visibility}
                    </span>
                  </div>
                  {col.description && (
                    <p className="text-xs text-mountain-500 mt-0.5">{col.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
