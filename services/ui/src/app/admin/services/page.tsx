import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import AppShell from '@/components/AppShell'
import AdminServicesClient from './AdminServicesClient'

export default async function AdminServicesPage() {
  const session = await auth()

  if (!session) {
    redirect('/api/auth/signin')
  }

  if (!session.user?.roles?.includes('admin')) {
    redirect('/dashboard')
  }

  return (
    <AppShell>
      <main className="flex-1 p-6">
        <AdminServicesClient />
      </main>
    </AppShell>
  )
}
