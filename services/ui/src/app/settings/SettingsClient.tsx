'use client'

import { useState, useEffect, useCallback } from 'react'
import { Moon, Bell, KeyRound, Save, Check } from 'lucide-react'

interface Preferences {
  in_app_notifications: boolean
  email_notifications: boolean
  theme: string
}

export default function SettingsClient() {
  const [prefs, setPrefs] = useState<Preferences>({ in_app_notifications: true, email_notifications: false, theme: 'dark' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const fetchPrefs = useCallback(async () => {
    try {
      const res = await fetch('/api/profile/preferences')
      if (res.ok) {
        const data = await res.json()
        setPrefs(p => ({ ...p, ...data }))
      }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchPrefs() }, [fetchPrefs])

  const savePrefs = async (updates: Partial<Preferences>) => {
    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch('/api/profile/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (res.ok) {
        const data = await res.json()
        setPrefs(p => ({ ...p, ...data }))
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } catch { /* ignore */ }
    finally { setSaving(false) }
  }

  if (loading) {
    return <div className="flex justify-center py-12"><div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" /></div>
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        {saved && <span className="flex items-center gap-1 text-sm text-brand-400"><Check className="w-4 h-4" /> Saved</span>}
      </div>

      <div className="space-y-6">
        {/* Theme */}
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
          <div className="flex items-center gap-2 mb-3">
            <Moon size={18} className="text-mountain-400" />
            <h2 className="text-lg font-semibold text-white">Theme</h2>
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-navy-900 border border-brand-600 text-sm text-white">
              <Moon size={14} /> Dark
            </span>
            <span className="text-xs text-mountain-500">More themes coming soon</span>
          </div>
        </div>

        {/* Notifications */}
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
          <div className="flex items-center gap-2 mb-3">
            <Bell size={18} className="text-mountain-400" />
            <h2 className="text-lg font-semibold text-white">Notifications</h2>
          </div>
          <div className="space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={prefs.in_app_notifications}
                onChange={(e) => {
                  const val = e.target.checked
                  setPrefs(p => ({ ...p, in_app_notifications: val }))
                  savePrefs({ in_app_notifications: val })
                }}
                className="h-4 w-4 rounded border-navy-600 bg-navy-900 text-brand-500 focus:ring-brand-500"
              />
              <div>
                <span className="text-sm text-white">In-app notifications</span>
                <p className="text-xs text-mountain-500">Show alerts in the notification panel</p>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={prefs.email_notifications}
                onChange={(e) => {
                  const val = e.target.checked
                  setPrefs(p => ({ ...p, email_notifications: val }))
                  savePrefs({ email_notifications: val })
                }}
                className="h-4 w-4 rounded border-navy-600 bg-navy-900 text-brand-500 focus:ring-brand-500"
              />
              <div>
                <span className="text-sm text-white">Email notifications</span>
                <p className="text-xs text-mountain-500">Receive email digests for important events</p>
              </div>
            </label>
          </div>
        </div>

        {/* API Keys — future */}
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 opacity-60">
          <div className="flex items-center gap-2 mb-3">
            <KeyRound size={18} className="text-mountain-400" />
            <h2 className="text-lg font-semibold text-white">API Keys</h2>
            <span className="text-xs px-2 py-0.5 rounded-full bg-navy-700 text-mountain-500">Coming soon</span>
          </div>
          <p className="text-sm text-mountain-400">Programmatic API access keys for external integrations.</p>
        </div>
      </div>
    </>
  )
}
