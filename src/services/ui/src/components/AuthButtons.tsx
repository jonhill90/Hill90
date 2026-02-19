'use client'

import { useSession, signIn, signOut } from "next-auth/react"

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0].toUpperCase())
    .join('')
}

export default function AuthButtons() {
  const { data: session, status } = useSession()

  if (status === "loading") {
    return (
      <div className="h-9 w-9 rounded-full bg-navy-800 animate-pulse" />
    )
  }

  if (session) {
    const name = session.user?.name || ''
    const initials = getInitials(name)

    return (
      <div className="flex items-center gap-3">
        <div
          className="h-9 w-9 rounded-full bg-brand-500 flex items-center justify-center text-sm font-semibold text-white select-none"
          title={name}
        >
          {initials || (
            <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v1.2c0 .7.5 1.2 1.2 1.2h16.8c.7 0 1.2-.5 1.2-1.2v-1.2c0-3.2-6.4-4.8-9.6-4.8z" />
            </svg>
          )}
        </div>
        <button
          onClick={() => signOut()}
          className="text-sm font-medium text-mountain-400 hover:text-white transition-colors"
        >
          Sign out
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={() => signIn("keycloak")}
      className="h-9 w-9 rounded-full bg-navy-800 border border-navy-700 flex items-center justify-center hover:border-mountain-500 hover:text-white transition-colors group"
      aria-label="Sign in"
    >
      <svg className="h-5 w-5 text-mountain-400 group-hover:text-white transition-colors" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v1.2c0 .7.5 1.2 1.2 1.2h16.8c.7 0 1.2-.5 1.2-1.2v-1.2c0-3.2-6.4-4.8-9.6-4.8z" />
      </svg>
    </button>
  )
}
