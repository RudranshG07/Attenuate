import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Attenuate",
  description: "A child name can never hold more power than its parent.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
