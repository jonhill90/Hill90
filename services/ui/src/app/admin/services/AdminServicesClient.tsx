'use client'

import { useState, useEffect, useCallback } from 'react'
import { ExternalLink } from 'lucide-react'
import { ADMIN_SERVICES } from '@/utils/admin-services'
import StatusBadge from '@/components/StatusBadge'

interface ServiceStatus {
  name: string
  status: 'healthy' | 'unhealthy' | 'loading'
  responseTime?: number
}

const AUTH_LABELS: Record<string, string> = {
  oidc: 'SSO',
  'basic-auth': 'Basic Auth',
  'static-creds': 'Static Creds',
  'master-key': 'Master Key',
  native: 'Native',
}

export default function AdminServicesClient() {
  const [statuses, setStatuses] = useState<Record<string, ServiceStatus>>(() => {
    const initial: Record<string, ServiceStatus> = {}
    for (const svc of ADMIN_SERVICES) {
      initial[svc.id] = { name: svc.name, status: 'loading' }
    }
    return initial
  })
  const [lastChecked, setLastChecked] = useState<string>('')

  const fetchHealth = useCallback(async () => {
    setStatuses((prev) => {
      const next = { ...prev }
      for (const key of Object.keys(next)) {
        next[key] = { ...next[key], status: 'loading' }
      }
      return next
    })

    try {
      const res = await fetch('/api/admin/services/health')
      const data = await res.json()

      if (data.services) {
        setStatuses((prev) => {
          const next = { ...prev }
          for (const result of data.services) {
            const svc = ADMIN_SERVICES.find((s) => s.name === result.name)
            if (svc) {
              next[svc.id] = {
                name: result.name,
                status: result.status,
                responseTime: result.responseTime,
              }
            }
          }
          return next
        })
      }
      setLastChecked(new Date().toLocaleTimeString())
    } catch {
      setStatuses((prev) => {
        const next = { ...prev }
        for (const key of Object.keys(next)) {
          next[key] = { ...next[key], status: 'unhealthy' }
        }
        return next
      })
      setLastChecked(new Date().toLocaleTimeString())
    }
  }, [])

  useEffect(() => {
    fetchHealth()
  }, [fetchHealth])

  return (
    <>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Admin Services</h1>
          <p className="text-sm text-mountain-400 mt-1">
            Platform tools and infrastructure dashboards
          </p>
          {lastChecked && (
            <p className="text-xs text-mountain-500 mt-1">
              Last checked: {lastChecked}
            </p>
          )}
        </div>
        <button
          onClick={fetchHealth}
          aria-label="Refresh"
          className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors cursor-pointer"
        >
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {ADMIN_SERVICES.map((svc) => {
          const status = statuses[svc.id]

          return (
            <div
              key={svc.id}
              className="rounded-lg border border-navy-700 bg-navy-800 p-5 flex flex-col"
            >
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-white">{svc.name}</h3>
                <StatusBadge status={status?.status ?? 'loading'} />
              </div>

              <p className="text-sm text-mountain-400 mb-4 flex-1">{svc.purpose}</p>

              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-navy-700 text-mountain-400">
                  {AUTH_LABELS[svc.authMethod] ?? svc.authMethod}
                </span>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-navy-700 text-mountain-400">
                  {svc.network === 'tailscale' ? 'Tailscale' : 'Public'}
                </span>
                {status?.responseTime !== undefined && (
                  <span className="text-xs text-mountain-500">
                    {status.responseTime}ms
                  </span>
                )}
              </div>

              <a
                href={svc.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-400 hover:text-brand-300 transition-colors"
              >
                Launch
                <ExternalLink size={14} aria-hidden="true" />
              </a>
            </div>
          )
        })}
      </div>
    </>
  )
}
