import { requireSession } from "@/lib/auth";
import { UsageClient } from "./UsageClient";

export default async function UsagePage() {
  await requireSession();
  return <UsageClient />;
}
