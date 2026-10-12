import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Script from 'next/script';
import { Poppins } from 'next/font/google';
import './globals.css';

const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'GDP Wirestock',
    template: '%s · GDP Wirestock',
  },
  description: 'Rubrics, golden autorating, human AI evaluation and stability runs.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${poppins.className} h-dvh overflow-hidden antialiased`} suppressHydrationWarning>
        <Script id="gdp-theme" strategy="beforeInteractive">
          {`try{var t=localStorage.getItem('gdp-theme');if(t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`}
        </Script>
        {children}
      </body>
    </html>
  );
}
