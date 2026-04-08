'use client'

import { useState } from 'react'
import { Moon, Bell, KeyRound } from 'lucide-react'

export default function SettingsClient() {
  const [theme] = useState('dark')
  const [emailNotifs, setEmailNotifs] = useState(false)
  const [inAppNotifs, setInAppNotifs] = useState(true)

  return (
    <>
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

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
                checked={inAppNotifs}
                onChange={(e) => setInAppNotifs(e.target.checked)}
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
                checked={emailNotifs}
                onChange={(e) => setEmailNotifs(e.target.checked)}
                className="h-4 w-4 rounded border-navy-600 bg-navy-900 text-brand-500 focus:ring-brand-500"
              />
              <div>
                <span className="text-sm text-white">Email notifications</span>
                <p className="text-xs text-mountain-500">Receive email digests for important events</p>
              </div>
            </label>
          </div>
          <p className="text-xs text-mountain-500 mt-3 italic">Notification delivery is not yet active. Preferences will be saved once the backend is implemented.</p>
        </div>

        {/* API Keys */}
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
          <div className="flex items-center gap-2 mb-3">
            <KeyRound size={18} className="text-mountain-400" />
            <h2 className="text-lg font-semibold text-white">API Keys</h2>
          </div>
          <div className="rounded-md border border-navy-700 bg-navy-900 p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-white font-mono">hill90_sk_••••••••••••••••</p>
                <p className="text-xs text-mountain-500 mt-1">Personal API key</p>
              </div>
              <button
                disabled
                className="px-3 py-1.5 text-xs font-medium rounded-md border border-navy-600 text-mountain-500 cursor-not-allowed"
              >
                Reveal
              </button>
            </div>
          </div>
          <p className="text-xs text-mountain-500 mt-3 italic">API key management coming soon. Keys will allow programmatic access to the Hill90 API.</p>
        </div>
      </div>
    </>
  )
}
