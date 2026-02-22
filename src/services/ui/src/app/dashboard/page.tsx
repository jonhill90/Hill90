import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import AppShell from '@/components/AppShell';
import DashboardClient from './DashboardClient';

export default async function Dashboard() {
  const session = await auth();

  if (!session) {
    redirect('/api/auth/signin');
  }

  return (
    <AppShell navExtra={<span className="text-sm font-medium text-white">Dashboard</span>}>
      <main className="flex-1 px-6 py-12 max-w-4xl mx-auto w-full">
        <DashboardClient session={session} />
      </main>
    </AppShell>
  );
}
