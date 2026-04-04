'use client'

import { useState, useEffect, useCallback } from 'react'

interface Collection {
  id: string
  name: string
  description: string
  visibility: string
  created_by: string
  created_at: string
}

interface Source {
  id: string
  collection_id: string
  title: string
  source_type: string
  source_url: string | null
  status: string
  error_message: string | null
  content_hash: string
  created_at: string
  chunk_count?: number
}

interface SearchResult {
  chunk_id: string
  content: string
  headline: string
  score: number
  quality_score: number
  quality_label: 'high' | 'medium' | 'low'
  chunk_index: number
  source_title: string
  source_url: string | null
  collection_name: string
}

interface QualitySummary {
  avg_score: number
  min_score: number
  max_score: number
  distribution: { high: number; medium: number; low: number }
}

interface UsageEntry {
  id: string
  name?: string
  title?: string
  collection_name?: string
  retrieval_count: number
}

interface RequesterTypeStats {
  requester_type: string
  total: number
  zero_result_count: number
  zero_result_rate: number
}

interface SharedStats {
  search: {
    total: number
    zero_result_count: number
    zero_result_rate: number
    avg_duration_ms: number | null
    by_requester_type: RequesterTypeStats[]
  }
  ingest: {
    total_jobs: number
    completed: number
    failed: number
    running: number
    pending: number
    error_rate: number
    avg_processing_ms: number | null
  }
  sources: {
    by_status: Record<string, number>
    by_type: Record<string, number>
  }
  corpus: {
    total_collections: number
    total_sources: number
    total_chunks: number
    total_tokens: number
  }
  usage: {
    top_collections: UsageEntry[]
    top_sources: UsageEntry[]
  }
  since: string | null
}

type Tab = 'collections' | 'search' | 'quality'

export default function SharedKnowledgeClient() {
  // Data state
  const [collections, setCollections] = useState<Collection[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [selectedCollection, setSelectedCollection] = useState<Collection | null>(null)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [qualitySummary, setQualitySummary] = useState<QualitySummary | null>(null)

  // UI state
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<Tab>('collections')
  const [showCollectionForm, setShowCollectionForm] = useState(false)
  const [editingCollectionId, setEditingCollectionId] = useState<string | null>(null)
  const [showSourceForm, setShowSourceForm] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCollectionFilter, setSearchCollectionFilter] = useState('')
  const [searching, setSearching] = useState(false)
  const [stats, setStats] = useState<SharedStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [timeRange, setTimeRange] = useState<string>('')

  // Form state
  const [collectionForm, setCollectionForm] = useState({ name: '', description: '', visibility: 'private' })
  const [collectionFormError, setCollectionFormError] = useState('')
  const [sourceForm, setSourceForm] = useState({ title: '', source_type: 'text', raw_content: '', source_url: '' })
  const [sourceFormError, setSourceFormError] = useState('')

  // Fetch collections
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

  // Fetch sources for a collection
  const fetchSources = useCallback(async (collectionId: string) => {
    try {
      const res = await fetch(`/api/shared-knowledge/sources?collection_id=${collectionId}`)
      if (res.ok) {
        setSources(await res.json())
      }
    } catch {
      // silent
    }
  }, [])

  const fetchStats = useCallback(async (since?: string) => {
    setStatsLoading(true)
    try {
      const params = since ? `?since=${since}` : ''
      const res = await fetch(`/api/shared-knowledge/stats${params}`)
      if (res.ok) {
        setStats(await res.json())
      }
    } catch {
      // silent
    } finally {
      setStatsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCollections()
  }, [fetchCollections])

  // When a collection is selected, fetch its sources
  useEffect(() => {
    if (selectedCollection) {
      fetchSources(selectedCollection.id)
    } else {
      setSources([])
    }
  }, [selectedCollection, fetchSources])

  useEffect(() => {
    if (activeTab === 'quality') {
      fetchStats(timeRange || undefined)
    }
  }, [activeTab, timeRange, fetchStats])

  // --- Collection CRUD ---

  const resetCollectionForm = () => {
    setCollectionForm({ name: '', description: '', visibility: 'private' })
    setCollectionFormError('')
    setShowCollectionForm(false)
    setEditingCollectionId(null)
  }

  const handleCollectionSubmit = async () => {
    setCollectionFormError('')
    if (!collectionForm.name.trim()) {
      setCollectionFormError('Name is required')
      return
    }

    try {
      const url = editingCollectionId
        ? `/api/shared-knowledge/collections/${editingCollectionId}`
        : '/api/shared-knowledge/collections'
      const method = editingCollectionId ? 'PUT' : 'POST'

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectionForm),
      })

      if (res.ok) {
        resetCollectionForm()
        await fetchCollections()
      } else {
        const data = await res.json()
        setCollectionFormError(data.error || 'Failed to save collection')
      }
    } catch {
      setCollectionFormError('Request failed')
    }
  }

  const handleEditCollection = (col: Collection) => {
    setCollectionForm({ name: col.name, description: col.description, visibility: col.visibility })
    setEditingCollectionId(col.id)
    setShowCollectionForm(true)
  }

  const handleDeleteCollection = async (col: Collection) => {
    if (!confirm(`Delete collection "${col.name}"? This will remove all sources and chunks.`)) return
    setActionLoading(col.id)
    try {
      const res = await fetch(`/api/shared-knowledge/collections/${col.id}`, { method: 'DELETE' })
      if (res.ok) {
        if (selectedCollection?.id === col.id) {
          setSelectedCollection(null)
        }
        await fetchCollections()
      } else {
        const data = await res.json()
        alert(data.error || 'Failed to delete collection')
      }
    } catch {
      alert('Failed to delete collection')
    } finally {
      setActionLoading(null)
    }
  }

  // --- Source CRUD ---

  const resetSourceForm = () => {
    setSourceForm({ title: '', source_type: 'text', raw_content: '', source_url: '' })
    setSourceFormError('')
    setShowSourceForm(false)
  }

  const handleSourceSubmit = async () => {
    setSourceFormError('')
    if (!sourceForm.title.trim()) {
      setSourceFormError('Title is required')
      return
    }
    if (sourceForm.source_type === 'web_page') {
      if (!sourceForm.source_url.trim()) {
        setSourceFormError('URL is required for web page sources')
        return
      }
    } else {
      if (!sourceForm.raw_content.trim()) {
        setSourceFormError('Content is required')
        return
      }
    }

    if (!selectedCollection) return

    try {
      const body: Record<string, string> = {
        collection_id: selectedCollection.id,
        title: sourceForm.title,
        source_type: sourceForm.source_type,
      }
      if (sourceForm.source_type === 'web_page') {
        body.source_url = sourceForm.source_url
      } else {
        body.raw_content = sourceForm.raw_content
      }

      const res = await fetch('/api/shared-knowledge/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        resetSourceForm()
        await fetchSources(selectedCollection.id)
      } else {
        const data = await res.json()
        setSourceFormError(data.error || data.detail || 'Failed to create source')
      }
    } catch {
      setSourceFormError('Request failed')
    }
  }

  const handleDeleteSource = async (src: Source) => {
    if (!confirm(`Delete source "${src.title}"?`)) return
    setActionLoading(src.id)
    try {
      const res = await fetch(`/api/shared-knowledge/sources/${src.id}`, { method: 'DELETE' })
      if (res.ok && selectedCollection) {
        await fetchSources(selectedCollection.id)
      } else if (!res.ok) {
        const data = await res.json()
        alert(data.error || 'Failed to delete source')
      }
    } catch {
      alert('Failed to delete source')
    } finally {
      setActionLoading(null)
    }
  }

  // --- Search ---

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setSearching(true)
    try {
      const params = new URLSearchParams({ q: searchQuery })
      if (searchCollectionFilter) {
        params.set('collection_id', searchCollectionFilter)
      }
      const res = await fetch(`/api/shared-knowledge/search?${params}`)
      if (res.ok) {
        const data = await res.json()
        setSearchResults(data.results || [])
        setQualitySummary(data.quality_summary || null)
      }
    } catch {
      // silent
    } finally {
      setSearching(false)
    }
  }

  // --- Render ---

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      active: 'bg-green-900/40 text-green-400 border-green-700',
      pending: 'bg-yellow-900/40 text-yellow-400 border-yellow-700',
      error: 'bg-red-900/40 text-red-400 border-red-700',
    }
    return (
      <span className={`px-2 py-0.5 text-xs font-medium rounded border ${colors[status] || 'bg-navy-700 text-mountain-400 border-navy-600'}`}>
        {status}
      </span>
    )
  }

  const visibilityBadge = (v: string) => (
    <span className={`px-2 py-0.5 text-xs font-medium rounded border ${
      v === 'shared' ? 'bg-brand-900/30 text-brand-400 border-brand-700' : 'bg-navy-700 text-mountain-400 border-navy-600'
    }`}>
      {v}
    </span>
  )

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Library</h1>
          <p className="text-sm text-mountain-400 mt-1">Manage collections, sources, and search across shared knowledge</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-navy-700">
        <button
          onClick={() => setActiveTab('collections')}
          className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
            activeTab === 'collections'
              ? 'text-brand-400 border-b-2 border-brand-500'
              : 'text-mountain-400 hover:text-white'
          }`}
        >
          Collections & Sources
        </button>
        <button
          onClick={() => setActiveTab('search')}
          className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
            activeTab === 'search'
              ? 'text-brand-400 border-b-2 border-brand-500'
              : 'text-mountain-400 hover:text-white'
          }`}
        >
          Search
        </button>
        <button
          onClick={() => setActiveTab('quality')}
          className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
            activeTab === 'quality'
              ? 'text-brand-400 border-b-2 border-brand-500'
              : 'text-mountain-400 hover:text-white'
          }`}
        >
          Quality
        </button>
      </div>

      {/* Collections & Sources Tab */}
      {activeTab === 'collections' && (
        <div className="flex gap-6">
          {/* Collections sidebar */}
          <div className="w-72 shrink-0">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-mountain-400 uppercase tracking-wider">Collections</h2>
              <button
                onClick={() => { resetCollectionForm(); setShowCollectionForm(true) }}
                className="px-3 py-1 text-xs font-medium rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
              >
                New
              </button>
            </div>

            {/* Collection form */}
            {showCollectionForm && (
              <div className="rounded-lg border border-navy-700 bg-navy-800 p-4 mb-3">
                <h3 className="text-sm font-semibold text-white mb-3">
                  {editingCollectionId ? 'Edit Collection' : 'New Collection'}
                </h3>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-mountain-400 mb-1">Name</label>
                    <input
                      type="text"
                      value={collectionForm.name}
                      onChange={e => setCollectionForm(f => ({ ...f, name: e.target.value }))}
                      className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-1.5 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                      placeholder="Collection name"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-mountain-400 mb-1">Description</label>
                    <input
                      type="text"
                      value={collectionForm.description}
                      onChange={e => setCollectionForm(f => ({ ...f, description: e.target.value }))}
                      className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-1.5 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                      placeholder="Optional description"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-mountain-400 mb-1">Visibility</label>
                    <select
                      value={collectionForm.visibility}
                      onChange={e => setCollectionForm(f => ({ ...f, visibility: e.target.value }))}
                      className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-1.5 text-sm text-white focus:border-brand-500 focus:outline-none"
                    >
                      <option value="private">Private</option>
                      <option value="shared">Shared</option>
                    </select>
                  </div>
                  {collectionFormError && <p className="text-xs text-red-400">{collectionFormError}</p>}
                  <div className="flex gap-2">
                    <button onClick={handleCollectionSubmit} className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer">
                      {editingCollectionId ? 'Update' : 'Create'}
                    </button>
                    <button onClick={resetCollectionForm} className="px-3 py-1.5 text-xs font-medium rounded-md border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer">
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Collection list */}
            {collections.length === 0 ? (
              <div className="rounded-lg border border-navy-700 bg-navy-800 p-6 text-center">
                <p className="text-sm text-mountain-400">No collections yet</p>
              </div>
            ) : (
              <div className="space-y-1">
                {collections.map(col => (
                  <div
                    key={col.id}
                    onClick={() => setSelectedCollection(col)}
                    className={`rounded-lg border p-3 cursor-pointer transition-colors ${
                      selectedCollection?.id === col.id
                        ? 'border-brand-600 bg-navy-800'
                        : 'border-navy-700 bg-navy-900 hover:bg-navy-800'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-white truncate">{col.name}</span>
                      {visibilityBadge(col.visibility)}
                    </div>
                    {col.description && (
                      <p className="text-xs text-mountain-500 mt-1 truncate">{col.description}</p>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        onClick={e => { e.stopPropagation(); handleEditCollection(col) }}
                        className="px-2 py-0.5 text-xs font-medium rounded border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer"
                      >
                        Edit
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); handleDeleteCollection(col) }}
                        disabled={actionLoading === col.id}
                        className="px-2 py-0.5 text-xs font-medium rounded border border-red-700 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sources panel */}
          <div className="flex-1 min-w-0">
            {!selectedCollection ? (
              <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
                <p className="text-mountain-400">Select a collection to view its sources</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-white">
                    {selectedCollection.name}
                    <span className="text-sm text-mountain-400 font-normal ml-2">
                      {sources.length} source{sources.length !== 1 ? 's' : ''}
                    </span>
                  </h2>
                  <button
                    onClick={() => { resetSourceForm(); setShowSourceForm(true) }}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
                  >
                    Add Source
                  </button>
                </div>

                {/* Source form */}
                {showSourceForm && (
                  <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-4">
                    <h3 className="text-lg font-semibold text-white mb-4">Add Source</h3>
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm text-mountain-400 mb-1">Title</label>
                          <input
                            type="text"
                            value={sourceForm.title}
                            onChange={e => setSourceForm(f => ({ ...f, title: e.target.value }))}
                            className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                            placeholder="Source title"
                          />
                        </div>
                        <div>
                          <label className="block text-sm text-mountain-400 mb-1">Type</label>
                          <select
                            value={sourceForm.source_type}
                            onChange={e => setSourceForm(f => ({ ...f, source_type: e.target.value }))}
                            className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none"
                          >
                            <option value="text">Text</option>
                            <option value="markdown">Markdown</option>
                            <option value="web_page">Web Page</option>
                          </select>
                        </div>
                      </div>
                      {sourceForm.source_type === 'web_page' ? (
                        <div>
                          <label className="block text-sm text-mountain-400 mb-1">URL</label>
                          <input
                            type="url"
                            value={sourceForm.source_url}
                            onChange={e => setSourceForm(f => ({ ...f, source_url: e.target.value }))}
                            className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                            placeholder="https://example.com/article"
                          />
                        </div>
                      ) : (
                        <div>
                          <label className="block text-sm text-mountain-400 mb-1">Content</label>
                          <textarea
                            value={sourceForm.raw_content}
                            onChange={e => setSourceForm(f => ({ ...f, raw_content: e.target.value }))}
                            rows={6}
                            className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none resize-y"
                            placeholder={sourceForm.source_type === 'markdown' ? '# Heading\n\nContent...' : 'Paste text content here...'}
                          />
                        </div>
                      )}
                      {sourceFormError && <p className="text-sm text-red-400">{sourceFormError}</p>}
                      <div className="flex gap-3">
                        <button onClick={handleSourceSubmit} className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer">
                          Create Source
                        </button>
                        <button onClick={resetSourceForm} className="px-4 py-2 text-sm font-medium rounded-lg border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer">
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Sources list */}
                {sources.length === 0 ? (
                  <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
                    <p className="text-mountain-400 mb-2">No sources in this collection</p>
                    <p className="text-sm text-mountain-500">Add text, markdown, or web page sources to build your knowledge base</p>
                  </div>
                ) : (
                  <div className="rounded-lg border border-navy-700 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-navy-800 text-mountain-400 text-left">
                        <tr>
                          <th className="px-4 py-3 font-medium">Title</th>
                          <th className="px-4 py-3 font-medium">Type</th>
                          <th className="px-4 py-3 font-medium">Status</th>
                          <th className="px-4 py-3 font-medium">Created</th>
                          <th className="px-4 py-3 font-medium text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-navy-700">
                        {sources.map(src => (
                          <tr key={src.id} className="bg-navy-900 hover:bg-navy-800 transition-colors">
                            <td className="px-4 py-3">
                              <div className="text-white font-medium">{src.title}</div>
                              {src.source_url && (
                                <a href={src.source_url} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-400 hover:text-brand-300 truncate block max-w-xs">
                                  {src.source_url}
                                </a>
                              )}
                              {src.error_message && (
                                <p className="text-xs text-red-400 mt-0.5">{src.error_message}</p>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <span className="px-2 py-0.5 text-xs font-medium rounded border bg-navy-700 text-mountain-300 border-navy-600">
                                {src.source_type}
                              </span>
                            </td>
                            <td className="px-4 py-3">{statusBadge(src.status)}</td>
                            <td className="px-4 py-3 text-mountain-400">
                              {new Date(src.created_at).toLocaleDateString()}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2 justify-end">
                                <button
                                  onClick={() => handleDeleteSource(src)}
                                  disabled={actionLoading === src.id}
                                  className="px-2.5 py-1 text-xs font-medium rounded-md border border-red-700 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                                >
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Search Tab */}
      {activeTab === 'search' && (
        <div>
          <div className="flex gap-3 mb-6">
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              className="flex-1 rounded-md border border-navy-600 bg-navy-900 px-4 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
              placeholder="Search shared knowledge..."
            />
            <select
              value={searchCollectionFilter}
              onChange={e => setSearchCollectionFilter(e.target.value)}
              className="rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none"
            >
              <option value="">All collections</option>
              {collections.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <button
              onClick={handleSearch}
              disabled={searching || !searchQuery.trim()}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {searching ? 'Searching...' : 'Search'}
            </button>
          </div>

          {searchResults.length === 0 ? (
            <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
              <p className="text-mountain-400">
                {searchQuery ? 'No results found' : 'Enter a query to search shared knowledge'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {qualitySummary && (
                <div className="flex items-center gap-4 rounded-lg border border-navy-700 bg-navy-800 px-4 py-2 text-xs text-mountain-400" data-testid="quality-summary">
                  <span>Avg: {Number(qualitySummary.avg_score).toFixed(2)}</span>
                  <span className="text-green-400">{qualitySummary.distribution.high} high</span>
                  <span className="text-yellow-400">{qualitySummary.distribution.medium} medium</span>
                  <span className="text-red-400">{qualitySummary.distribution.low} low</span>
                </div>
              )}
              {searchResults.map((r, i) => (
                <div key={`${r.chunk_id}-${i}`} className="rounded-lg border border-navy-700 bg-navy-800 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-medium text-white">{r.source_title}</span>
                    <span className="text-xs text-mountain-500">in {r.collection_name}</span>
                    {r.source_url && (
                      <a href={r.source_url} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-400 hover:text-brand-300">
                        Source
                      </a>
                    )}
                    <span className={`px-1.5 py-0.5 text-xs font-medium rounded ${
                      r.quality_label === 'high' ? 'bg-green-900/40 text-green-400 border border-green-700'
                        : r.quality_label === 'medium' ? 'bg-yellow-900/40 text-yellow-400 border border-yellow-700'
                        : 'bg-red-900/40 text-red-400 border border-red-700'
                    }`} data-testid="quality-badge">
                      {r.quality_label}
                    </span>
                    <span className="text-xs text-mountain-500 ml-auto">
                      Score: {Number(r.quality_score ?? r.score).toFixed(4)}
                    </span>
                  </div>
                  <p
                    className="text-sm text-mountain-300 leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: r.headline || r.content }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Quality Tab */}
      {activeTab === 'quality' && (
        <div>
          {/* Time range filter */}
          <div className="flex gap-2 mb-6">
            {[
              { label: '24h', value: new Date(Date.now() - 86400000).toISOString() },
              { label: '7d', value: new Date(Date.now() - 7 * 86400000).toISOString() },
              { label: '30d', value: new Date(Date.now() - 30 * 86400000).toISOString() },
              { label: 'All Time', value: '' },
            ].map(r => (
              <button
                key={r.label}
                onClick={() => setTimeRange(r.value)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  timeRange === r.value
                    ? 'bg-brand-600 text-white'
                    : 'border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {statsLoading ? (
            <div className="flex items-center justify-center py-24">
              <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
            </div>
          ) : !stats ? (
            <div className="rounded-lg border border-navy-700 bg-navy-800 p-12 text-center">
              <p className="text-mountain-400">No stats available</p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Summary cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="rounded-lg border border-navy-700 bg-navy-800 p-4 text-center">
                  <p className="text-xs text-mountain-400 uppercase tracking-wider mb-1">Total Searches</p>
                  <p className="text-2xl font-bold text-white">{Number(stats.search.total).toLocaleString()}</p>
                </div>
                <div className="rounded-lg border border-navy-700 bg-navy-800 p-4 text-center">
                  <p className="text-xs text-mountain-400 uppercase tracking-wider mb-1">Zero-Result %</p>
                  <p className="text-2xl font-bold text-white">{(Number(stats.search.zero_result_rate) * 100).toFixed(1)}%</p>
                </div>
                <div className="rounded-lg border border-navy-700 bg-navy-800 p-4 text-center">
                  <p className="text-xs text-mountain-400 uppercase tracking-wider mb-1">Ingest Err %</p>
                  <p className="text-2xl font-bold text-white">{(Number(stats.ingest.error_rate) * 100).toFixed(1)}%</p>
                </div>
                <div className="rounded-lg border border-navy-700 bg-navy-800 p-4 text-center">
                  <p className="text-xs text-mountain-400 uppercase tracking-wider mb-1">Total Chunks</p>
                  <p className="text-2xl font-bold text-white">{Number(stats.corpus.total_chunks).toLocaleString()}</p>
                </div>
              </div>

              {/* Search Breakdown */}
              <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
                <h3 className="text-sm font-semibold text-white mb-3">Search Breakdown</h3>
                <div className="flex flex-wrap gap-2 mb-2">
                  {stats.search.by_requester_type.map(rt => (
                    <span key={rt.requester_type} className="px-3 py-1 text-xs font-medium rounded-md border border-navy-600 bg-navy-900 text-mountain-300">
                      {Number(rt.total).toLocaleString()} {rt.requester_type} &middot; {(Number(rt.zero_result_rate) * 100).toFixed(1)}% zero
                    </span>
                  ))}
                </div>
                <p className="text-xs text-mountain-500">
                  Avg latency: {stats.search.avg_duration_ms != null ? `${Number(stats.search.avg_duration_ms)}ms` : 'N/A'}
                </p>
              </div>

              {/* Ingest Health */}
              <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
                <h3 className="text-sm font-semibold text-white mb-3">Ingest Health</h3>
                <div className="flex flex-wrap gap-2 mb-2">
                  {[
                    { label: 'completed', count: stats.ingest.completed, color: 'bg-green-900/40 text-green-400 border-green-700' },
                    { label: 'failed', count: stats.ingest.failed, color: 'bg-red-900/40 text-red-400 border-red-700' },
                    { label: 'running', count: stats.ingest.running, color: 'bg-blue-900/40 text-blue-400 border-blue-700' },
                    { label: 'pending', count: stats.ingest.pending, color: 'bg-yellow-900/40 text-yellow-400 border-yellow-700' },
                  ].map(s => (
                    <span key={s.label} className={`px-3 py-1 text-xs font-medium rounded-md border ${s.color}`}>
                      {Number(s.count).toLocaleString()} {s.label}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-mountain-500">
                  Avg processing: {stats.ingest.avg_processing_ms != null ? `${Number(stats.ingest.avg_processing_ms)}ms` : 'N/A'}
                </p>
              </div>

              {/* Sources */}
              <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
                <h3 className="text-sm font-semibold text-white mb-3">Sources</h3>
                <div className="mb-2">
                  <p className="text-xs text-mountain-500 mb-1">By status</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(stats.sources.by_status).map(([status, count]) => (
                      <span key={status} className="px-3 py-1 text-xs font-medium rounded-md border border-navy-600 bg-navy-900 text-mountain-300">
                        {Number(count).toLocaleString()} {status}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-mountain-500 mb-1">By type</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(stats.sources.by_type).map(([type, count]) => (
                      <span key={type} className="px-3 py-1 text-xs font-medium rounded-md border border-navy-600 bg-navy-900 text-mountain-300">
                        {Number(count).toLocaleString()} {type}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {/* Corpus */}
              <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
                <h3 className="text-sm font-semibold text-white mb-3">Corpus</h3>
                <p className="text-sm text-mountain-300">
                  {Number(stats.corpus.total_collections).toLocaleString()} collections &middot;{' '}
                  {Number(stats.corpus.total_sources).toLocaleString()} sources &middot;{' '}
                  {Number(stats.corpus.total_chunks).toLocaleString()} chunks &middot;{' '}
                  ~{Math.round(Number(stats.corpus.total_tokens) / 1000).toLocaleString()}k tokens
                </p>
              </div>

              {/* Usage Rankings */}
              {stats.usage && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Top Collections */}
                  <div className="rounded-lg border border-navy-700 bg-navy-800 p-5" data-testid="top-collections">
                    <h3 className="text-sm font-semibold text-white mb-3">Most Accessed Collections</h3>
                    {stats.usage.top_collections.length === 0 ? (
                      <p className="text-xs text-mountain-500">No collection usage data yet</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-mountain-500">
                            <th className="pb-2 font-medium">Collection</th>
                            <th className="pb-2 font-medium text-right">Retrievals</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-navy-700">
                          {stats.usage.top_collections.map(c => (
                            <tr key={c.id}>
                              <td className="py-1.5 text-mountain-300">{c.name}</td>
                              <td className="py-1.5 text-mountain-300 text-right">{Number(c.retrieval_count).toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  {/* Top Sources */}
                  <div className="rounded-lg border border-navy-700 bg-navy-800 p-5" data-testid="top-sources">
                    <h3 className="text-sm font-semibold text-white mb-3">Most Accessed Sources</h3>
                    {stats.usage.top_sources.length === 0 ? (
                      <p className="text-xs text-mountain-500">No source usage data yet</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-mountain-500">
                            <th className="pb-2 font-medium">Source</th>
                            <th className="pb-2 font-medium">Collection</th>
                            <th className="pb-2 font-medium text-right">Retrievals</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-navy-700">
                          {stats.usage.top_sources.map(s => (
                            <tr key={s.id}>
                              <td className="py-1.5 text-mountain-300">{s.title}</td>
                              <td className="py-1.5 text-mountain-500 text-xs">{s.collection_name}</td>
                              <td className="py-1.5 text-mountain-300 text-right">{Number(s.retrieval_count).toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
