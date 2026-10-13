import type { Metadata, Viewport } from "next";
import { THEME_KEY } from "@/lib/ui/settings";
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

// Sets the saved theme on the root element before the first paint, so a
// chosen theme does not flash the system one while the page loads.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The script above may add data-theme before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* text/plain on the client keeps React from warning about an inline
            script; the server-rendered copy is the one the browser runs. */}
        <script
          type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
