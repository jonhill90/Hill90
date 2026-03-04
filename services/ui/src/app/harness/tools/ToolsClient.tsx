'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'

interface Tool {
  id: string
  name: string
  description: string
  install_method: 'builtin' | 'apt' | 'binary'
  install_ref: string
  is_platform: boolean
  created_at: string
}

function installMethodBadge(method: Tool['install_method']): { label: string; classes: string } {
  switch (method) {
    case 'builtin':
      return { label: 'Builtin', classes: 'bg-brand-900/50 text-brand-400 border border-brand-700' }
    case 'apt':
      return { label: 'APT', classes: 'bg-amber-900/50 text-amber-400 border border-amber-700' }
    case 'binary':
      return { label: 'Binary', classes: 'bg-red-900/50 text-red-400 border border-red-700' }
  }
}

export default function ToolsClient() {
  const { data: session } = useSession()
  const isAdmin = (session?.user as any)?.roles?.includes('admin')

  const [tools, setTools] = useState<Tool[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [formError, setFormError] = useState('')
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    install_method: 'builtin' as Tool['install_method'],
    install_ref: '',
  })

  const fetchTools = useCallback(async () => {
    try {
      const res = await fetch('/api/tools')
      if (res.ok) setTools(await res.json())
    } catch (err) {
      console.error('Failed to fetch tools:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTools()
  }, [fetchTools])

  const resetForm = () => {
    setFormData({ name: '', description: '', install_method: 'builtin', install_ref: '' })
    setFormError('')
    setEditingId(null)
    setShowForm(false)
  }

  const handleEdit = (tool: Tool) => {
    setFormData({
      name: tool.name,
      description: tool.description || '',
      install_method: tool.install_method,
      install_ref: tool.install_ref || '',
    })
    setEditingId(tool.id)
    setFormError('')
    setShowForm(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')

    if (!formData.name.trim()) {
      setFormError('Name is required')
      return
    }

    const body: Record<string, string> = {
      name: formData.name.trim(),
      install_method: formData.install_method,
    }
    if (formData.description.trim()) body.description = formData.description.trim()
    if (formData.install_ref.trim()) body.install_ref = formData.install_ref.trim()

    try {
      const url = editingId ? `/api/tools/${editingId}` : '/api/tools'
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        resetForm()
        await fetchTools()
      } else {
        const data = await res.json()
        setFormError(data.error || (editingId ? 'Failed to update tool' : 'Failed to create tool'))
      }
    } catch {
      setFormError('Request failed')
    }
  }

  const handleDelete = async (tool: Tool) => {
    if (!confirm(`Delete tool "${tool.name}"? Skills referencing it must be updated first.`)) return
    setActionLoading(tool.id)
    try {
      const res = await fetch(`/api/tools/${tool.id}`, { method: 'DELETE' })
      if (res.ok) {
        await fetchTools()
      } else {
        const data = await res.json()
        alert(data.error || 'Failed to delete tool')
      }
    } catch {
      alert('Failed to delete tool')
    } finally {
      setActionLoading(null)
    }
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
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Tools</h1>
          <p className="text-sm text-mountain-400 mt-1">
            Tools are dependencies that skills can reference.
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => { resetForm(); setShowForm(true) }}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
          >
            Add Tool
          </button>
        )}
      </div>

      {showForm && (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-6">
          <h2 className="text-lg font-semibold text-white mb-4">
            {editingId ? 'Edit Tool' : 'New Tool'}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-mountain-400 mb-1">Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                  placeholder="gh"
                />
              </div>
              <div>
                <label className="block text-sm text-mountain-400 mb-1">Install Method</label>
                <select
                  value={formData.install_method}
                  onChange={(e) => setFormData({ ...formData, install_method: e.target.value as Tool['install_method'] })}
                  className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none"
                >
                  <option value="builtin">Builtin</option>
                  <option value="apt">APT</option>
                  <option value="binary">Binary</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm text-mountain-400 mb-1">
                Description <span className="text-mountain-500">(optional)</span>
              </label>
              <input
                type="text"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                placeholder="GitHub CLI"
              />
            </div>

            <div>
              <label className="block text-sm text-mountain-400 mb-1">
                Install Reference <span className="text-mountain-500">(optional)</span>
              </label>
              <input
                type="text"
                value={formData.install_ref}
                onChange={(e) => setFormData({ ...formData, install_ref: e.target.value })}
                className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                placeholder="Package name or download URL"
              />
            </div>

            {formError && (
              <p className="text-sm text-red-400">{formError}</p>
            )}

            <div className="flex items-center gap-2">
              <button
                type="submit"
                className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
              >
                {editingId ? 'Update' : 'Create'}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {tools.length === 0 ? (
        <p className="text-sm text-mountain-500 mb-6">No tools yet</p>
      ) : (
        <div className="space-y-3">
          {tools.map((tool) => {
            const badge = installMethodBadge(tool.install_method)
            return (
              <div
                key={tool.id}
                className="rounded-lg border border-navy-700 bg-navy-900 px-4 py-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="font-medium text-white">{tool.name}</span>
                      {tool.is_platform && (
                        <span className="px-2 py-0.5 text-xs rounded-md bg-mountain-500/20 text-mountain-300 border border-mountain-500/30">
                          Seeded
                        </span>
                      )}
                      <span className={`px-2 py-0.5 text-xs rounded-md ${badge.classes}`}>
                        {badge.label}
                      </span>
                    </div>
                    {tool.description && (
                      <p className="text-sm text-mountain-300 mt-1">{tool.description}</p>
                    )}
                    {tool.install_ref && (
                      <p className="text-xs text-mountain-500 mt-2 font-mono break-all">
                        {tool.install_ref}
                      </p>
                    )}
                  </div>
                  {isAdmin && (
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => handleEdit(tool)}
                        className="px-3 py-1.5 text-xs font-medium rounded-md border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer"
                      >
                        Edit
                      </button>
                      {!tool.is_platform && (
                        <button
                          onClick={() => handleDelete(tool)}
                          disabled={actionLoading === tool.id}
                          className="px-3 py-1.5 text-xs font-medium rounded-md border border-red-700 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
