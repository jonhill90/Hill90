'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { Terminal, FolderOpen, Heart } from 'lucide-react'

interface ToolsConfig {
  shell: { enabled: boolean; allowed_binaries: string[]; denied_patterns: string[]; max_timeout: number }
  filesystem: { enabled: boolean; read_only: boolean; allowed_paths: string[]; denied_paths: string[] }
  health: { enabled: boolean }
}

interface Tool {
  id: string
  name: string
  description: string
  install_method: string
  install_ref: string
  is_platform: boolean
}

interface Skill {
  id: string
  name: string
  description: string
  scope: string
  tools_config: ToolsConfig
  instructions_md: string
  is_platform: boolean
  tools: Array<{ id: string; name: string; description: string; install_method: string }>
  created_at: string
  updated_at: string
}

function scopeBadge(scope: string): { label: string; colorClasses: string } {
  switch (scope) {
    case 'container_local':
      return { label: 'Container', colorClasses: 'bg-brand-900/50 text-brand-400 border border-brand-700' }
    case 'host_docker':
      return { label: 'Host · Docker', colorClasses: 'bg-amber-900/50 text-amber-400 border border-amber-700' }
    case 'vps_system':
      return { label: 'VPS · System', colorClasses: 'bg-red-900/50 text-red-400 border border-red-700' }
    default:
      return { label: scope, colorClasses: 'bg-navy-900 text-mountain-400 border border-navy-700' }
  }
}

export default function SkillsClient() {
  const { data: session } = useSession()
  const isAdmin = (session?.user as any)?.roles?.includes('admin')

  const [skills, setSkills] = useState<Skill[]>([])
  const [allTools, setAllTools] = useState<Tool[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([])
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    instructions_md: '',
  })
  const [formError, setFormError] = useState('')

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch('/api/skills')
      if (res.ok) setSkills(await res.json())
    } catch (err) {
      console.error('Failed to fetch skills:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSkills()
    fetch('/api/tools')
      .then(res => res.ok ? res.json() : [])
      .then(data => setAllTools(data))
      .catch(() => {})
  }, [fetchSkills])

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      instructions_md: '',
    })
    setSelectedToolIds([])
    setFormError('')
    setShowForm(false)
    setEditingId(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')

    if (!formData.name.trim()) {
      setFormError('Name is required')
      return
    }

    const selectedToolNames = allTools
      .filter((tool) => selectedToolIds.includes(tool.id))
      .map((tool) => tool.name)
    const tools_config: ToolsConfig = {
      shell: {
        enabled: true,
        allowed_binaries: selectedToolNames,
        denied_patterns: [],
        max_timeout: 300,
      },
      filesystem: {
        enabled: true,
        read_only: false,
        allowed_paths: ['/workspace', '/data'],
        denied_paths: [],
      },
      health: { enabled: true },
    }

    const body: Record<string, unknown> = {
      name: formData.name.trim(),
      tools_config,
      instructions_md: formData.instructions_md,
    }
    body.tool_ids = selectedToolIds
    if (formData.description.trim()) {
      body.description = formData.description.trim()
    }

    try {
      const url = editingId
        ? `/api/skills/${editingId}`
        : '/api/skills'
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        resetForm()
        await fetchSkills()
      } else {
        const data = await res.json()
        setFormError(data.error || (editingId ? 'Failed to update skill' : 'Failed to create skill'))
      }
    } catch {
      setFormError('Request failed')
    }
  }

  const handleDelete = async (skill: Skill) => {
    if (!confirm(`Delete skill "${skill.name}"? Agents using this skill will keep their current tool configuration.`)) return
    setActionLoading(skill.id)
    try {
      const res = await fetch(`/api/skills/${skill.id}`, { method: 'DELETE' })
      if (res.ok) {
        await fetchSkills()
      } else {
        const data = await res.json()
        alert(data.error || 'Failed to delete skill')
      }
    } catch {
      alert('Failed to delete skill')
    } finally {
      setActionLoading(null)
    }
  }

  const handleEdit = (skill: Skill) => {
    setFormData({
      name: skill.name,
      description: skill.description || '',
      instructions_md: skill.instructions_md || '',
    })
    setSelectedToolIds(skill.tools?.map(t => t.id) || [])
    setEditingId(skill.id)
    setShowForm(true)
    setFormError('')
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
          <h1 className="text-2xl font-bold">Skills</h1>
          <p className="text-sm text-mountain-400 mt-1">
            {skills.length} skill{skills.length !== 1 ? 's' : ''}
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => { resetForm(); setShowForm(true) }}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
          >
            Add Skill
          </button>
        )}
      </div>

      {/* Create/Edit form */}
      {showForm && (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-6">
          <h2 className="text-lg font-semibold text-white mb-4">
            {editingId ? 'Edit Skill' : 'New Skill'}
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
                  placeholder="Skill name"
                />
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
                  placeholder="Brief description"
                />
              </div>
            </div>

            {/* Instructions */}
            <div>
              <label className="block text-sm text-mountain-400 mb-1">
                Instructions <span className="text-mountain-500">(optional)</span>
              </label>
              <textarea
                value={formData.instructions_md}
                onChange={(e) => setFormData({ ...formData, instructions_md: e.target.value })}
                rows={4}
                className="w-full rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white font-mono placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
                placeholder="Behavioral instructions for agents using this skill"
              />
              <p className="text-xs text-mountain-500 mt-1">
                Tool access is applied when a skill is assigned to an agent. Instructions take effect on the agent&apos;s next start.
              </p>
            </div>

            {/* Required Tools */}
            {allTools.length > 0 && (
              <div>
                <label className="block text-sm text-mountain-400 mb-2">Required Tools</label>
                <div className="space-y-2">
                  {allTools.map((tool) => (
                    <label key={tool.id} className="flex items-center gap-2 text-sm text-white cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedToolIds.includes(tool.id)}
                        onChange={() => {
                          setSelectedToolIds(prev =>
                            prev.includes(tool.id)
                              ? prev.filter(id => id !== tool.id)
                              : [...prev, tool.id]
                          )
                        }}
                        className="rounded border-navy-600"
                        aria-label={tool.name}
                      />
                      {tool.name}
                      <span className="text-xs text-mountain-500">({tool.description})</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <p className="text-xs text-mountain-500">
              Runtime access controls are managed internally from skill dependencies and RBAC scope.
            </p>

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

      {/* Skills list */}
      {skills.length === 0 ? (
        <p className="text-sm text-mountain-500 mb-6">No skills yet</p>
      ) : (
        <div className="space-y-3">
          {skills.map((skill) => {
            const isExpanded = expandedId === skill.id
            const tc = skill.tools_config

            return (
              <div
                key={skill.id}
                className="rounded-lg border border-navy-700 bg-navy-900 overflow-hidden"
              >
                {/* Summary row */}
                <div
                  className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-navy-800 transition-colors"
                  onClick={() => setExpandedId(isExpanded ? null : skill.id)}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpandedId(isExpanded ? null : skill.id) }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-white">{skill.name}</span>
                      {skill.is_platform && (
                        <span className="px-2 py-0.5 text-xs rounded-md bg-mountain-500/20 text-mountain-300 border border-mountain-500/30">
                          Platform
                        </span>
                      )}
                      {skill.scope && (
                        <span className={`px-2 py-0.5 text-xs rounded-md ${scopeBadge(skill.scope).colorClasses}`}>
                          {scopeBadge(skill.scope).label}
                        </span>
                      )}
                      <div className="flex flex-wrap gap-1">
                        {tc.shell.enabled && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-md bg-brand-900/50 text-brand-400 border border-brand-700">
                            <Terminal className="w-3 h-3" /> Shell
                          </span>
                        )}
                        {tc.filesystem.enabled && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-md bg-brand-900/50 text-brand-400 border border-brand-700">
                            <FolderOpen className="w-3 h-3" /> Filesystem
                            {tc.filesystem.read_only && <span className="text-mountain-400">(ro)</span>}
                          </span>
                        )}
                        {tc.health.enabled && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-md bg-brand-900/50 text-brand-400 border border-brand-700">
                            <Heart className="w-3 h-3" /> Health
                          </span>
                        )}
                      </div>
                    </div>
                    {skill.description && (
                      <p className="text-xs text-mountain-400 mt-1 truncate">{skill.description}</p>
                    )}
                  </div>
                  <div className="shrink-0">
                    <svg
                      className={`w-4 h-4 text-mountain-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="border-t border-navy-700 px-4 py-4 bg-navy-800/50">
                    {skill.description && (
                      <p className="text-sm text-mountain-300 mb-4">{skill.description}</p>
                    )}

                    {/* Instructions preview */}
                    {skill.instructions_md && (
                      <div className="mb-4">
                        <h3 className="text-xs font-medium text-mountain-400 uppercase tracking-wide mb-2">Instructions</h3>
                        <div className="rounded-md border border-navy-700 bg-navy-900 p-3">
                          <p className="text-sm text-mountain-300 whitespace-pre-wrap">{skill.instructions_md}</p>
                        </div>
                      </div>
                    )}

                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm mb-4">
                      {/* Tool dependencies */}
                      <div>
                        <dt className="text-mountain-400 mb-1">Tool Dependencies</dt>
                        <dd className="text-white">
                          {(skill.tools?.length || 0) > 0 ? (
                            <div className="space-y-1">
                              <div className="flex flex-wrap gap-1">
                                {skill.tools!.map((tool) => (
                                  <span key={tool.id} className="px-2 py-0.5 text-xs rounded-md bg-navy-900 text-brand-400 border border-navy-700 font-mono">
                                    {tool.name}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <span className="text-mountain-500">None declared</span>
                          )}
                        </dd>
                      </div>

                      {/* Filesystem config */}
                      <div>
                        <dt className="text-mountain-400 mb-1">Filesystem</dt>
                        <dd className="text-white">
                          {tc.filesystem.enabled ? (
                            <div className="space-y-1">
                              <div className="text-xs">
                                {tc.filesystem.read_only ? 'Read-only' : 'Read-write'}
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {tc.filesystem.allowed_paths.map((p) => (
                                  <span key={p} className="px-2 py-0.5 text-xs rounded-md bg-navy-900 text-brand-400 border border-navy-700">
                                    {p}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <span className="text-mountain-500">Disabled</span>
                          )}
                        </dd>
                      </div>

                      <div>
                        <dt className="text-mountain-400">Created</dt>
                        <dd className="text-white mt-1">{new Date(skill.created_at).toLocaleString()}</dd>
                      </div>
                    </dl>

                    {/* Actions -- admin only; seeded examples remain editable */}
                    {isAdmin && (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleEdit(skill)}
                          className="px-3 py-1.5 text-xs font-medium rounded-md border border-navy-600 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors cursor-pointer"
                        >
                          Edit
                        </button>
                        {!skill.is_platform && (
                          <button
                            onClick={() => handleDelete(skill)}
                            disabled={actionLoading === skill.id}
                            className="px-3 py-1.5 text-xs font-medium rounded-md border border-red-700 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
