import { requireSession } from "@/lib/auth";
import { AdminCompaniesClient } from "./AdminCompaniesClient";

export default async function AdminCompaniesPage() {
  await requireSession();
  return <AdminCompaniesClient />;
}
