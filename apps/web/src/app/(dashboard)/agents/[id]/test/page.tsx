import { requireSession } from "@/lib/auth";
import { AgentSandboxClient } from "./AgentSandboxClient";

export default async function AgentTestPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  return <AgentSandboxClient agentId={id} />;
}
