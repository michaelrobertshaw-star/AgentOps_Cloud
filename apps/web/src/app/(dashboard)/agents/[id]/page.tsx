import { requireSession } from "@/lib/auth";
import { AgentDetailClient } from "./AgentDetailClient";

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  return <AgentDetailClient agentId={id} />;
}
