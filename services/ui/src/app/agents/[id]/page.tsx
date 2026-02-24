import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import AppShell from '@/components/AppShell'
import AgentDetailClient from './AgentDetailClient'

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session) {
    redirect('/api/auth/signin')
  }

  const { id } = await params

  return (
    <AppShell>
      <main className="flex-1 px-6 py-12 max-w-4xl mx-auto w-full">
        <AgentDetailClient agentId={id} session={session} />
      </main>
    </AppShell>
  )
}
