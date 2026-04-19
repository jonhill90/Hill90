'use client'

import { Suspense } from 'react'
import { useSession } from 'next-auth/react'
import { redirect, useSearchParams } from 'next/navigation'
import AppShell from '@/components/AppShell'
import SharedKnowledgeClient from './SharedKnowledgeClient'

function SharedKnowledgeInner() {
  const { data: session, status } = useSession()
  const searchParams = useSearchParams()
  const initialTab = searchParams.get('tab') as 'search' | null
  const initialQuery = searchParams.get('q') || ''

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-navy-900">
        <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!session) {
    redirect('/api/auth/signin')
  }

  return (
    <AppShell>
      <main className="flex-1 px-6 py-12 max-w-6xl mx-auto w-full">
        <SharedKnowledgeClient initialTab={initialTab || undefined} initialQuery={initialQuery || undefined} />
      </main>
    </AppShell>
  )
}

export default function SharedKnowledgePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-navy-900">
        <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    }>
      <SharedKnowledgeInner />
    </Suspense>
  )
}
