import { requireSession } from "@/lib/auth";
import { AuditClient } from "./AuditClient";

export default async function AuditPage() {
  await requireSession();
  return <AuditClient />;
}
