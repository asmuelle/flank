import type { Metadata } from 'next';
import { Inter, JetBrains_Mono, Source_Serif_4 } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

// Three families, self-hosted + preloaded by next/font (no layout shift, no third-party origin).
// All three are variable fonts, so weight is the axis — never a separate request per weight.
const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-source-serif',
});
const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });
const jetBrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains',
});

export const metadata: Metadata = {
  title: 'Flank — Competitor Radar',
  description:
    'Versioned cross-run diffing with span-pinned provenance: what changed, why it matters, with proof.',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sourceSerif.variable} ${inter.variable} ${jetBrainsMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
