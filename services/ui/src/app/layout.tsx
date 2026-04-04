import type { Metadata } from 'next';
import { auth } from '@/auth';
import Providers from '@/components/Providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hill90',
  description: 'Hill90 Microservices Platform',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <html lang="en">
      <body className="bg-navy-900 text-white antialiased">
        <Providers session={session}>{children}</Providers>
      </body>
    </html>
  );
}
