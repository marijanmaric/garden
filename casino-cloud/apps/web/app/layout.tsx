import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'M1 Casino Cloud',
  description: 'Modular casino management, floor control and accounting platform',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

// Applies the saved theme before paint to avoid a light flash in dark mode.
const themeScript = `try{var t=localStorage.getItem('m1-theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
