import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ERP API Debug Center",
  description: "QA dashboard for sanitized ERP API logs",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
