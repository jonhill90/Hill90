import type { Metadata } from 'next';
import Providers from '@/components/Providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hill90',
  description: 'Hill90 Microservices Platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-navy-900 text-white antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
