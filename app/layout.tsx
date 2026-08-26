import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://relatorio-ccb-brasilia-xi.vercel.app"),
  title: "Casas de Oração — Brasília & Águas Lindas",
  description: "Encontre casas de oração por dia, período e distância, com rotas no Waze e Google Maps.",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicons/favicon.ico" },
      { url: "/favicons/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicons/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicons/favicon-192x192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/favicons/favicon-180x180.png", sizes: "180x180", type: "image/png" }],
    shortcut: "/favicons/favicon.ico",
  },
  openGraph: {
    title: "Casas de Oração — Brasília & Águas Lindas",
    description: "Mais perto. Mais simples. Direto ao caminho.",
    locale: "pt_BR",
    type: "website",
    images: [{ url: "/favicons/favicon-512x512.png", width: 512, height: 512, alt: "Casas de Oração — Brasília e Águas Lindas" }],
  },
  twitter: { card: "summary", images: ["/favicons/favicon-512x512.png"] },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
