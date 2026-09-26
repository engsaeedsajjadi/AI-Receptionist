import type { ReactNode } from "react";
import { AuthProvider } from "@/components/dashboard/auth";
import { DashboardShell } from "@/components/dashboard/shell";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShell>{children}</DashboardShell>
    </AuthProvider>
  );
}
