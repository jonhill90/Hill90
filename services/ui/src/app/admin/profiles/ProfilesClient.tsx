'use client'

import { useState, useEffect, useCallback } from 'react'

interface ContainerProfile {
  id: string
  name: string
  description: string
  docker_image: string
  default_cpus: string
  default_mem_limit: string
  default_pids_limit: number
  is_platform: boolean
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export default function ProfilesClient() {
  const [profiles, setProfiles] = useState<ContainerProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', description: '', docker_image: 'hill90/agentbox:latest', default_cpus: '1.0', default_mem_limit: '1g', default_pids_limit: '200' })

  const fetchProfiles = useCallback(async () => {
    try {
      setError(null)
      const res = await fetch('/api/container-profiles')
      if (res.ok) {
        setProfiles(await res.json())
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error || `Failed to load profiles (${res.status})`)
      }
    } catch {
      setError('Unable to reach profiles API')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchProfiles()
  }, [fetchProfiles])

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Container Profiles</h1>
        <button onClick={() => { setShowForm(true); setEditingId(null); setForm({ name: '', description: '', docker_image: 'hill90/agentbox:latest', default_cpus: '1.0', default_mem_limit: '1g', default_pids_limit: '200' }) }}
          className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium cursor-pointer">+ New Profile</button>
      </div>

      {showForm && (
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 mb-6">
          <h3 className="text-lg font-semibold text-white mb-4">{editingId ? 'Edit Profile' : 'New Profile'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-sm text-mountain-400 mb-1">Name</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none" /></div>
            <div><label className="block text-sm text-mountain-400 mb-1">Docker Image</label>
              <input value={form.docker_image} onChange={e => setForm(f => ({ ...f, docker_image: e.target.value }))} className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white font-mono focus:border-brand-500 focus:outline-none" /></div>
            <div><label className="block text-sm text-mountain-400 mb-1">CPUs</label>
              <input value={form.default_cpus} onChange={e => setForm(f => ({ ...f, default_cpus: e.target.value }))} className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none" /></div>
            <div><label className="block text-sm text-mountain-400 mb-1">Memory Limit</label>
              <input value={form.default_mem_limit} onChange={e => setForm(f => ({ ...f, default_mem_limit: e.target.value }))} className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none" /></div>
            <div><label className="block text-sm text-mountain-400 mb-1">PID Limit</label>
              <input value={form.default_pids_limit} onChange={e => setForm(f => ({ ...f, default_pids_limit: e.target.value }))} className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none" /></div>
            <div><label className="block text-sm text-mountain-400 mb-1">Description</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="w-full rounded border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white focus:border-brand-500 focus:outline-none" /></div>
          </div>
          <div className="flex gap-2 mt-4">
            <button onClick={async () => {
              const url = editingId ? `/api/container-profiles/${editingId}` : '/api/container-profiles'
              const method = editingId ? 'PUT' : 'POST'
              const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, default_pids_limit: parseInt(form.default_pids_limit) }) })
              if (res.ok) { setShowForm(false); fetchProfiles() }
            }} disabled={!form.name} className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium disabled:opacity-50 cursor-pointer">
              {editingId ? 'Save' : 'Create'}
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-mountain-400 hover:text-white cursor-pointer">Cancel</button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-700/50 bg-red-900/20 px-4 py-3 mb-6 flex items-center justify-between" data-testid="profiles-error">
          <span className="text-sm text-red-400">{error}</span>
          <button
            onClick={() => { setLoading(true); fetchProfiles() }}
            className="text-xs text-red-300 hover:text-white transition-colors cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12" data-testid="loading">
          <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
        </div>
      ) : (
        <div className="rounded-lg border border-navy-700 bg-navy-800 overflow-hidden" data-testid="profiles-table">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-navy-700">
                <th className="text-left px-4 py-3 text-xs font-medium text-mountain-400 uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-mountain-400 uppercase tracking-wider">Image</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-mountain-400 uppercase tracking-wider">CPUs</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-mountain-400 uppercase tracking-wider">Memory</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-mountain-400 uppercase tracking-wider">PIDs</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-mountain-400 uppercase tracking-wider">Type</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-700">
              {profiles.map(profile => (
                <tr key={profile.id} className="hover:bg-navy-700/50 transition-colors" data-testid="profile-row">
                  <td className="px-4 py-3">
                    <div>
                      <p className="font-medium text-white">{profile.name}</p>
                      {profile.description && (
                        <p className="text-xs text-mountain-500 mt-0.5 line-clamp-1">{profile.description}</p>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-mountain-300">{profile.docker_image}</td>
                  <td className="px-4 py-3 text-mountain-300">{profile.default_cpus}</td>
                  <td className="px-4 py-3 text-mountain-300">{profile.default_mem_limit}</td>
                  <td className="px-4 py-3 text-mountain-300">{profile.default_pids_limit}</td>
                  <td className="px-4 py-3">
                    {profile.is_platform ? (
                      <span className="px-2 py-0.5 text-xs rounded-md bg-brand-900/50 text-brand-400 border border-brand-700">
                        Platform
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 text-xs rounded-md bg-navy-900 text-mountain-400 border border-navy-600">
                        Custom
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      <button onClick={() => { setForm({ name: profile.name, description: profile.description || '', docker_image: profile.docker_image, default_cpus: profile.default_cpus, default_mem_limit: profile.default_mem_limit, default_pids_limit: String(profile.default_pids_limit) }); setEditingId(profile.id); setShowForm(true) }}
                        className="text-xs text-mountain-400 hover:text-white cursor-pointer">Edit</button>
                      {!profile.is_platform && (
                        <button onClick={async () => { if (!confirm('Delete?')) return; await fetch(`/api/container-profiles/${profile.id}`, { method: 'DELETE' }); fetchProfiles() }}
                          className="text-xs text-red-400 hover:text-red-300 cursor-pointer ml-2">Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {profiles.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-mountain-500">
                    No container profiles found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
