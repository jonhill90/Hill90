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
      </div>

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
                </tr>
              ))}
              {profiles.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-mountain-500">
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
