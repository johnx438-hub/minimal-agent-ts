import type { Metadata } from "next";
import { MyRuntimeProvider } from "@/app/MyRuntimeProvider";

import "./globals.css";

export const metadata: Metadata = {
  title: "minimal-gui",
  description: "assistant-ui + minimal-agent-ts (Route A ExternalStore)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Provider must be *inside* body — never wrap <html>.
  return (
    <html lang="en" className="h-dvh">
      <body className="h-dvh font-sans">
        <MyRuntimeProvider>{children}</MyRuntimeProvider>
      </body>
    </html>
  );
}
