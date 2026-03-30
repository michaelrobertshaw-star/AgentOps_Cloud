import { requireSession } from "@/lib/auth";
import { IncidentsClient } from "./IncidentsClient";

export default async function IncidentsPage() {
  await requireSession();
  return <IncidentsClient />;
}
