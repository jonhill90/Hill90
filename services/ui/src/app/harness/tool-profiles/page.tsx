import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import AppShell from '@/components/AppShell'
import ToolProfilesClient from './ToolProfilesClient'

export default async function ToolProfilesPage() {
  const session = await auth()

  if (!session) {
    redirect('/api/auth/signin')
  }

  return (
    <AppShell>
      <main className="flex-1 px-6 py-12 max-w-6xl mx-auto w-full">
        <ToolProfilesClient />
      </main>
    </AppShell>
  )
}
