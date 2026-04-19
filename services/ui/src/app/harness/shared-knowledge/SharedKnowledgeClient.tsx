'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Database, FileText, FolderOpen, Globe, Search, Plus, AlertCircle, Upload, Trash2, GitBranch } from 'lucide-react'

// ── Knowledge Graph Component ──────────────────────────────────────

interface GraphNode { id: string; type: string; label: string; meta?: Record<string, unknown> }
interface GraphEdge { source: string; target: string; label?: string }

function KnowledgeGraph() {
  const [data, setData] = useState<{ nodes: GraphNode[]; edges: GraphEdge[]; stats: Record<string, number> } | null>(null)
  const [loading, setLoading] = useState(true)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    fetch('/api/shared-knowledge/graph')
      .then(r => r.ok ? r.json() : null)
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!data || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.scale(dpr, dpr)

    ctx.fillStyle = '#0f1923'
    ctx.fillRect(0, 0, w, h)

    const typeColors: Record<string, string> = {
      collection: '#5b9a2f',
      source: '#3b82f6',
      agent: '#f59e0b',
    }
    const typeRadius: Record<string, number> = {
      collection: 24,
      source: 12,
      agent: 18,
    }

    // Layout: collections in center ring, sources around them, agents on right
    const positions = new Map<string, { x: number; y: number }>()
    const collections = data.nodes.filter(n => n.type === 'collection')
    const sources = data.nodes.filter(n => n.type === 'source')
    const agents = data.nodes.filter(n => n.type === 'agent')

    const cx = w / 2
    const cy = h / 2

    // Collections in center
    collections.forEach((c, i) => {
      const angle = (i / Math.max(collections.length, 1)) * Math.PI * 2 - Math.PI / 2
      const r = Math.min(w, h) * 0.15
      positions.set(c.id, { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r })
    })

    // Sources around their parent collection
    const sourcesByCollection = new Map<string, GraphNode[]>()
    for (const edge of data.edges) {
      if (!sourcesByCollection.has(edge.source)) sourcesByCollection.set(edge.source, [])
      const srcNode = sources.find(s => s.id === edge.target)
      if (srcNode) sourcesByCollection.get(edge.source)!.push(srcNode)
    }

    for (const [colId, srcs] of sourcesByCollection) {
      const colPos = positions.get(colId)
      if (!colPos) continue
      srcs.forEach((s, i) => {
        const angle = (i / srcs.length) * Math.PI * 2 - Math.PI / 2
        const r = Math.min(w, h) * 0.3
        positions.set(s.id, { x: colPos.x + Math.cos(angle) * r, y: colPos.y + Math.sin(angle) * r })
      })
    }

    // Agents on the right side
    agents.forEach((a, i) => {
      positions.set(a.id, { x: w - 80, y: 60 + i * 50 })
    })

    // Draw edges
    ctx.strokeStyle = '#2d3f54'
    ctx.lineWidth = 1
    for (const edge of data.edges) {
      const from = positions.get(edge.source)
      const to = positions.get(edge.target)
      if (!from || !to) continue
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
    }

    // Draw nodes
    for (const node of data.nodes) {
      const pos = positions.get(node.id)
      if (!pos) continue
      const r = typeRadius[node.type] || 10
      const color = typeColors[node.type] || '#6b7280'

      ctx.fillStyle = color + '33'
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()

      // Label
      ctx.fillStyle = '#c9d1d9'
      ctx.font = `${node.type === 'collection' ? 11 : 9}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      const label = node.label.length > 18 ? node.label.slice(0, 16) + '…' : node.label
      ctx.fillText(label, pos.x, pos.y + r + 14)

      // Chunk count for sources
      if (node.type === 'source' && node.meta?.chunk_count) {
        ctx.fillStyle = '#6b7280'
        ctx.font = '8px system-ui'
        ctx.fillText(`${node.meta.chunk_count} chunks`, pos.x, pos.y + r + 24)
      }
    }

    // Legend
    ctx.font = '11px system-ui'
    ctx.textAlign = 'left'
    let ly = 20
    for (const [type, color] of Object.entries(typeColors)) {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(20, ly, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#c9d1d9'
      ctx.fillText(type.charAt(0).toUpperCase() + type.slice(1), 32, ly + 4)
      ly += 20
    }
  }, [data])

  if (loading) return <div className="flex justify-center py-12"><div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" /></div>
  if (!data) return <p className="text-mountain-500 text-center py-8">Failed to load graph</p>

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-mountain-400" />
          <span className="text-sm text-mountain-300">{data.stats.collections} collections · {data.stats.sources} sources · {data.stats.agents_with_knowledge} agents</span>
        </div>
      </div>
      <div className="rounded-lg border border-navy-700 bg-[#0f1923] overflow-hidden">
        <canvas ref={canvasRef} className="w-full" style={{ height: '450px' }} />
      </div>
    </div>
  )
}

/**
 * Highlight search terms in content by wrapping them in <b> tags.
 * Used as a fallback when the API headline is not available.
 */
function highlightTerms(text: string, query: string): string {
  if (!query.trim()) return text
  // Escape regex special chars in each search term
  const terms = query.trim().split(/\s+/).filter(Boolean)
  const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (escaped.length === 0) return text
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi')
  return text.replace(pattern, '<b>$1</b>')
}

function relativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString()
}

interface Collection {
  id: string
  name: string
  description: string
  visibility: string
  created_by: string
  created_at: string
  source_count?: number
  document_count?: number
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

type Tab = 'collections' | 'search' | 'quality' | 'graph'

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
  const fileInputRef = useRef<HTMLInputElement>(null)

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


  // --- File Upload ---
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !selectedCollection) return
    try {
      const text = await file.text()
      const isMarkdown = file.name.endsWith('.md')
      const body = {
        collection_id: selectedCollection.id,
        title: file.name,
        source_type: isMarkdown ? 'markdown' : 'text',
        raw_content: text,
      }
      const res = await fetch('/api/shared-knowledge/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        await fetchSources(selectedCollection.id)
      } else {
        const data = await res.json()
        alert(data.error || data.detail || 'Failed to upload file')
      }
    } catch {
      alert('Failed to read file')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // --- Bulk delete error sources ---
  const handleCleanupErrors = async () => {
    if (!selectedCollection) return
    const errorSources = sources.filter(s => s.status === 'error' || s.status === 'failed')
    if (errorSources.length === 0) return
    if (!confirm(`Delete ${errorSources.length} error source${errorSources.length !== 1 ? 's' : ''}?`)) return
    for (const src of errorSources) {
      try {
        await fetch(`/api/shared-knowledge/sources/${src.id}`, { method: 'DELETE' })
      } catch { /* continue */ }
    }
    await fetchSources(selectedCollection.id)
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
    const config: Record<string, { color: string; icon: React.ReactNode }> = {
      completed: {
        color: 'bg-green-900/40 text-green-400 border-green-700',
        icon: <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 mr-1.5" />,
      },
      active: {
        color: 'bg-green-900/40 text-green-400 border-green-700',
        icon: <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 mr-1.5" />,
      },
      processing: {
        color: 'bg-blue-900/40 text-blue-400 border-blue-700',
        icon: <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 mr-1.5 animate-pulse" />,
      },
      running: {
        color: 'bg-blue-900/40 text-blue-400 border-blue-700',
        icon: <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 mr-1.5 animate-pulse" />,
      },
      error: {
        color: 'bg-red-900/40 text-red-400 border-red-700',
        icon: <AlertCircle className="inline w-3 h-3 mr-1" />,
      },
      failed: {
        color: 'bg-red-900/40 text-red-400 border-red-700',
        icon: <AlertCircle className="inline w-3 h-3 mr-1" />,
      },
      pending: {
        color: 'bg-yellow-900/40 text-yellow-400 border-yellow-700',
        icon: <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 mr-1.5" />,
      },
    }
    const cfg = config[status] || {
      color: 'bg-navy-700 text-mountain-400 border-navy-600',
      icon: null,
    }
    return (
      <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded border ${cfg.color}`}>
        {cfg.icon}
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
        <button
          onClick={() => setActiveTab('graph')}
          className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
            activeTab === 'graph'
              ? 'text-brand-400 border-b-2 border-brand-500'
              : 'text-mountain-400 hover:text-white'
          }`}
        >
          Graph
        </button>
      </div>

      {/* Knowledge Graph Tab */}
      {activeTab === 'graph' && <KnowledgeGraph />}

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
              <div className="rounded-lg border border-dashed border-navy-600 bg-navy-800/50 p-6 text-center">
                <FolderOpen className="w-8 h-8 text-mountain-500 mx-auto mb-3" />
                <p className="text-sm font-medium text-mountain-400 mb-1">No collections yet</p>
                <p className="text-xs text-mountain-500 mb-3">Collections group related knowledge sources together.</p>
                <button
                  onClick={() => { resetCollectionForm(); setShowCollectionForm(true) }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  Create your first collection
                </button>
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
                    {(col.source_count != null || col.document_count != null) && (
                      <div className="flex items-center gap-3 mt-1.5 text-xs text-mountain-500">
                        {col.source_count != null && (
                          <span className="inline-flex items-center gap-1">
                            <FileText className="w-3 h-3" />
                            {col.source_count} source{col.source_count !== 1 ? 's' : ''}
                          </span>
                        )}
                        {col.document_count != null && (
                          <span className="inline-flex items-center gap-1">
                            <Database className="w-3 h-3" />
                            {col.document_count} doc{col.document_count !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
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
              <div className="rounded-lg border border-dashed border-navy-600 bg-navy-800/50 p-12 text-center">
                <FolderOpen className="w-10 h-10 text-mountain-500 mx-auto mb-3" />
                <p className="text-mountain-400 font-medium mb-1">No collection selected</p>
                <p className="text-sm text-mountain-500">Select a collection from the sidebar to view and manage its sources.</p>
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
                  <div className="flex items-center gap-2">
                    {sources.some(s => s.status === 'error' || s.status === 'failed') && (
                      <button
                        onClick={handleCleanupErrors}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border border-red-700 text-red-400 hover:bg-red-900/30 transition-colors cursor-pointer"
                      >
                        <Trash2 size={14} />
                        Clean Up Errors
                      </button>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".txt,.md"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer"
                    >
                      <Upload size={14} />
                      Upload File
                    </button>
                    <button
                      onClick={() => { resetSourceForm(); setShowSourceForm(true) }}
                      className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
                    >
                      Add Source
                    </button>
                  </div>
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
                  <div className="rounded-lg border border-dashed border-navy-600 bg-navy-800/50 p-12 text-center">
                    <FileText className="w-10 h-10 text-mountain-500 mx-auto mb-3" />
                    <p className="text-mountain-400 font-medium mb-1">No sources in this collection</p>
                    <p className="text-sm text-mountain-500 mb-4">Add text, markdown, or web page sources to build your knowledge base.</p>
                    <button
                      onClick={() => { resetSourceForm(); setShowSourceForm(true) }}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                      Add Source
                    </button>
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
                              <span title={new Date(src.created_at).toLocaleString()}>{relativeTime(src.created_at)}</span>
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
            <div className="rounded-lg border border-dashed border-navy-600 bg-navy-800/50 p-12 text-center">
              <Search className="w-10 h-10 text-mountain-500 mx-auto mb-3" />
              {searchQuery ? (
                <>
                  <p className="text-mountain-400 font-medium mb-1">No results found</p>
                  <p className="text-sm text-mountain-500">Try broadening your search terms or searching across all collections.</p>
                </>
              ) : (
                <>
                  <p className="text-mountain-400 font-medium mb-1">Search your knowledge base</p>
                  <p className="text-sm text-mountain-500">Enter a query above to search across all shared knowledge sources.</p>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-mountain-400">
                  {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} for &ldquo;{searchQuery}&rdquo;
                </p>
                {qualitySummary && (
                  <div className="flex items-center gap-3 text-xs text-mountain-400" data-testid="quality-summary">
                    <span>Avg: {Number(qualitySummary.avg_score).toFixed(2)}</span>
                    <span className="text-green-400">{qualitySummary.distribution.high} high</span>
                    <span className="text-yellow-400">{qualitySummary.distribution.medium} medium</span>
                    <span className="text-red-400">{qualitySummary.distribution.low} low</span>
                  </div>
                )}
              </div>
              {searchResults.map((r, i) => (
                <div key={`${r.chunk_id}-${i}`} className="rounded-lg border border-navy-700 bg-navy-800 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <FileText size={14} className="text-mountain-500 flex-shrink-0" />
                    <span className="text-sm font-medium text-white">{r.source_title}</span>
                    <span className="text-xs text-mountain-500">in {r.collection_name}</span>
                    {r.chunk_index != null && (
                      <span className="text-xs text-mountain-600">chunk {r.chunk_index + 1}</span>
                    )}
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
                      {Number(r.quality_score ?? r.score).toFixed(3)}
                    </span>
                  </div>
                  <p
                    className="text-sm text-mountain-300 leading-relaxed max-h-32 overflow-hidden [&_b]:text-white [&_b]:font-semibold"
                    dangerouslySetInnerHTML={{ __html: r.headline || highlightTerms(r.content, searchQuery) }}
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
            <div className="rounded-lg border border-dashed border-navy-600 bg-navy-800/50 p-12 text-center">
              <Database className="w-10 h-10 text-mountain-500 mx-auto mb-3" />
              <p className="text-mountain-400 font-medium mb-1">No stats available</p>
              <p className="text-sm text-mountain-500">Quality metrics will appear here once searches and ingestion have occurred.</p>
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
