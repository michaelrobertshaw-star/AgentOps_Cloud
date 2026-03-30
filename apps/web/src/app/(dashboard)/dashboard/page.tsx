import { requireSession } from "@/lib/auth";
import { DashboardClient } from "./DashboardClient";

export default async function DashboardPage() {
  await requireSession(); // guard — redirect to login if unauthenticated
  return <DashboardClient />;
}
