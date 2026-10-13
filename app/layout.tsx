import type { Metadata, Viewport } from "next";
import "./globals.css";

// The page title is rendered by the app, so it can name the open table.
export const metadata: Metadata = {
  description: "A group chat of AI models. You write a message, every agent answers it, and you decide what happens next.",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
