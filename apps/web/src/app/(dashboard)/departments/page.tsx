import { requireSession } from "@/lib/auth";
import { DepartmentsClient } from "./DepartmentsClient";

export default async function DepartmentsPage() {
  await requireSession();
  return <DepartmentsClient />;
}
