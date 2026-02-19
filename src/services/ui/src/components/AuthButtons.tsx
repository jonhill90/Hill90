'use client'

import { useSession, signIn, signOut } from "next-auth/react"

export default function AuthButtons() {
  const { data: session, status } = useSession()

  if (status === "loading") {
    return (
      <span className="text-sm text-mountain-400">Loading...</span>
    )
  }

  if (session) {
    return (
      <div className="flex items-center gap-4">
        <span className="text-sm text-mountain-400">{session.user?.name}</span>
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
      className="text-sm font-medium text-mountain-400 hover:text-white transition-colors"
    >
      Sign in
    </button>
  )
}
