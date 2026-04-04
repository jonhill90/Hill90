'use client'

import { SessionProvider } from "next-auth/react"
import ErrorBoundary from "./ErrorBoundary"

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary>
      <SessionProvider>{children}</SessionProvider>
    </ErrorBoundary>
  )
}
