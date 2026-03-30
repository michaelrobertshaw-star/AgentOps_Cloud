import { requireSession } from "@/lib/auth";
import { AgentsClient } from "./AgentsClient";

export default async function AgentsPage() {
  await requireSession();
  return <AgentsClient />;
}
