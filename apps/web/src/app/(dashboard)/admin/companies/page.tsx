import { requireAdmin } from "@/lib/auth";
import { AdminCompaniesClient } from "./AdminCompaniesClient";

export default async function AdminCompaniesPage() {
  await requireAdmin();
  return <AdminCompaniesClient />;
}
