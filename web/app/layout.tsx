import type { Metadata } from "next";

import { APP_NAME } from "@/lib/config";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: "Start agent runs, follow what the agent does, and approve the risky steps.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col text-sm">{children}</body>
    </html>
  );
}
