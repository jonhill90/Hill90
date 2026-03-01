import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import AppShell from '@/components/AppShell'
import ConnectionsClient from './ConnectionsClient'

export default async function ConnectionsPage() {
  const session = await auth()

  if (!session) {
    redirect('/api/auth/signin')
  }

  return (
    <AppShell>
      <main className="flex-1 px-6 py-12 max-w-6xl mx-auto w-full">
        <ConnectionsClient session={session} />
      </main>
    </AppShell>
  )
}
