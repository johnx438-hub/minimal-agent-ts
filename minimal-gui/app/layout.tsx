import type { Metadata } from "next";
import { MyRuntimeProvider } from "@/app/MyRuntimeProvider";
import { ThemeProvider } from "@/components/minimal/theme-provider";

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
  // Default dark class before hydrate (主黑+灰); ThemeProvider syncs localStorage
  return (
    <html lang="zh-CN" className="dark h-dvh" suppressHydrationWarning>
      <body className="h-dvh font-sans antialiased">
        <ThemeProvider>
          <MyRuntimeProvider>{children}</MyRuntimeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
