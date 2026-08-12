import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SDLC Routing Console",
  description: "Choose and customize the AI-SDLC routing policy — model and thinking capacity per phase.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
