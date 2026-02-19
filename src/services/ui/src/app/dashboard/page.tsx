import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/auth';
import HillLogo from '@/components/HillLogo';
import AuthButtons from '@/components/AuthButtons';
import DashboardClient from './DashboardClient';

export default async function Dashboard() {
  const session = await auth();

  if (!session) {
    redirect('/api/auth/signin');
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-navy-700">
        <Link href="/" aria-label="Go to homepage" className="logo-link inline-flex items-center">
          <HillLogo width={96} className="logo-glow-hold" />
        </Link>
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-white">Dashboard</span>
          <AuthButtons />
        </div>
      </nav>

      {/* Content */}
      <main className="flex-1 px-6 py-12 max-w-4xl mx-auto w-full">
        <DashboardClient session={session} />
      </main>

      {/* Footer */}
      <footer className="px-6 py-6 border-t border-navy-700 text-center text-sm text-mountain-500">
        &copy; {new Date().getFullYear()} Hill90
      </footer>
    </div>
  );
}
