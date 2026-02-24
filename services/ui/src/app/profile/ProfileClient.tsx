'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Session } from 'next-auth'

interface ProfileData {
  firstName?: string
  lastName?: string
  email?: string
  avatarUrl?: string
}

export default function ProfileClient({ session }: { session: Session }) {
  // Profile data
  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [loading, setLoading] = useState(true)

  // Name editing
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [nameSaving, setNameSaving] = useState(false)
  const [nameSuccess, setNameSuccess] = useState(false)
  const [nameError, setNameError] = useState('')

  // Avatar
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [avatarError, setAvatarError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Password
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [passwordNotAvailable, setPasswordNotAvailable] = useState(false)

  const fetchProfile = useCallback(async () => {
    try {
      const res = await fetch('/api/profile')
      if (res.ok) {
        const data = await res.json()
        setProfile(data)
        setFirstName(data.firstName || '')
        setLastName(data.lastName || '')
      }
    } catch (err) {
      console.error('Failed to fetch profile:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchAvatar = useCallback(async () => {
    try {
      const res = await fetch('/api/profile/avatar')
      if (res.ok) {
        const blob = await res.blob()
        setAvatarUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return URL.createObjectURL(blob)
        })
      } else {
        setAvatarUrl(null)
      }
    } catch {
      setAvatarUrl(null)
    }
  }, [])

  useEffect(() => {
    fetchProfile()
    fetchAvatar()
  }, [fetchProfile, fetchAvatar])

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (avatarUrl) URL.revokeObjectURL(avatarUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleNameSave = async () => {
    setNameError('')
    setNameSuccess(false)

    if (firstName.length > 100 || lastName.length > 100) {
      setNameError('Name must be 100 characters or less')
      return
    }

    setNameSaving(true)
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName }),
      })
      if (res.ok) {
        setNameSuccess(true)
        setTimeout(() => setNameSuccess(false), 3000)
      } else {
        const data = await res.json()
        setNameError(data.error || 'Failed to update name')
      }
    } catch {
      setNameError('Failed to update name')
    } finally {
      setNameSaving(false)
    }
  }

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setAvatarError('')

    if (file.size > 5 * 1024 * 1024) {
      setAvatarError('File must be under 5MB')
      return
    }

    if (!file.type.startsWith('image/')) {
      setAvatarError('File must be an image')
      return
    }

    setAvatarUploading(true)
    try {
      const formData = new FormData()
      formData.append('avatar', file)

      const res = await fetch('/api/profile/avatar', {
        method: 'POST',
        body: formData,
      })
      if (res.ok) {
        await fetchAvatar()
        window.dispatchEvent(new Event('avatar-changed'))
      } else {
        const data = await res.json()
        setAvatarError(data.error || 'Failed to upload avatar')
      }
    } catch {
      setAvatarError('Failed to upload avatar')
    } finally {
      setAvatarUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleAvatarDelete = async () => {
    setAvatarError('')
    setAvatarUploading(true)
    try {
      const res = await fetch('/api/profile/avatar', { method: 'DELETE' })
      if (res.ok) {
        setAvatarUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return null
        })
        window.dispatchEvent(new Event('avatar-changed'))
      } else {
        const data = await res.json()
        setAvatarError(data.error || 'Failed to delete avatar')
      }
    } catch {
      setAvatarError('Failed to delete avatar')
    } finally {
      setAvatarUploading(false)
    }
  }

  const handlePasswordChange = async () => {
    setPasswordError('')

    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match')
      return
    }

    setPasswordSaving(true)
    try {
      const res = await fetch('/api/profile/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      const data = await res.json()
      if (data.code === 'NOT_IMPLEMENTED') {
        setPasswordNotAvailable(true)
      } else if (!res.ok) {
        setPasswordError(data.error || 'Failed to change password')
      }
    } catch {
      setPasswordError('Failed to change password')
    } finally {
      setPasswordSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  const initials = session.user?.name
    ? session.user.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p.charAt(0).toUpperCase())
        .join('')
    : ''

  return (
    <>
      <h1 className="text-2xl font-bold text-white mb-8">Profile</h1>

      {/* Avatar Section */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-6 mb-4">
        <h2 className="text-lg font-semibold text-white mb-4">Profile Picture</h2>
        <div className="flex items-center gap-6">
          <div className="h-20 w-20 rounded-full bg-brand-500 flex items-center justify-center text-xl font-semibold text-white overflow-hidden flex-shrink-0">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt="Avatar"
                className="h-full w-full object-cover"
                onError={() => setAvatarUrl(null)}
              />
            ) : (
              initials || (
                <svg className="h-10 w-10 text-white" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v1.2c0 .7.5 1.2 1.2 1.2h16.8c.7 0 1.2-.5 1.2-1.2v-1.2c0-3.2-6.4-4.8-9.6-4.8z" />
                </svg>
              )
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={avatarUploading}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
              >
                {avatarUploading ? 'Uploading...' : 'Upload'}
              </button>
              {avatarUrl && (
                <button
                  onClick={handleAvatarDelete}
                  disabled={avatarUploading}
                  className="px-4 py-2 text-sm font-medium rounded-lg border border-navy-600 text-mountain-400 hover:text-white hover:border-red-500 transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                >
                  Remove
                </button>
              )}
            </div>
            <p className="text-xs text-mountain-500">Max 5MB. Will be resized to 256x256.</p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleAvatarUpload}
            />
          </div>
        </div>
        {avatarError && <p className="mt-3 text-sm text-red-400">{avatarError}</p>}
      </div>

      {/* Display Name Section */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-6 mb-4">
        <h2 className="text-lg font-semibold text-white mb-4">Display Name</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label htmlFor="firstName" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
              First Name
            </label>
            <input
              id="firstName"
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              maxLength={100}
              className="w-full px-3 py-2 rounded-lg bg-navy-900 border border-navy-600 text-white placeholder-mountain-500 focus:outline-none focus:border-brand-500 transition-colors"
              placeholder="First name"
            />
          </div>
          <div>
            <label htmlFor="lastName" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
              Last Name
            </label>
            <input
              id="lastName"
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              maxLength={100}
              className="w-full px-3 py-2 rounded-lg bg-navy-900 border border-navy-600 text-white placeholder-mountain-500 focus:outline-none focus:border-brand-500 transition-colors"
              placeholder="Last name"
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleNameSave}
            disabled={nameSaving}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
          >
            {nameSaving ? 'Saving...' : 'Save'}
          </button>
          {nameSuccess && <span className="text-sm text-brand-400">Saved</span>}
          {nameError && <span className="text-sm text-red-400">{nameError}</span>}
        </div>
        <div className="mt-4">
          <label className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">Email</label>
          <p className="text-white text-sm">{profile?.email || session.user?.email || 'Not set'}</p>
        </div>
      </div>

      {/* Password Section */}
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Change Password</h2>
        {passwordNotAvailable ? (
          <p className="text-sm text-mountain-400">
            Password change is not yet available. Please use the Keycloak account console to change your password.
          </p>
        ) : (
          <>
            <div className="space-y-4 mb-4 max-w-sm">
              <div>
                <label htmlFor="currentPassword" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
                  Current Password
                </label>
                <input
                  id="currentPassword"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-navy-900 border border-navy-600 text-white placeholder-mountain-500 focus:outline-none focus:border-brand-500 transition-colors"
                />
              </div>
              <div>
                <label htmlFor="newPassword" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
                  New Password
                </label>
                <input
                  id="newPassword"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-navy-900 border border-navy-600 text-white placeholder-mountain-500 focus:outline-none focus:border-brand-500 transition-colors"
                />
              </div>
              <div>
                <label htmlFor="confirmPassword" className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">
                  Confirm New Password
                </label>
                <input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-navy-900 border border-navy-600 text-white placeholder-mountain-500 focus:outline-none focus:border-brand-500 transition-colors"
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handlePasswordChange}
                disabled={passwordSaving || !currentPassword || !newPassword || !confirmPassword}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
              >
                {passwordSaving ? 'Changing...' : 'Change Password'}
              </button>
              {passwordError && <span className="text-sm text-red-400">{passwordError}</span>}
            </div>
          </>
        )}
      </div>
    </>
  )
}
