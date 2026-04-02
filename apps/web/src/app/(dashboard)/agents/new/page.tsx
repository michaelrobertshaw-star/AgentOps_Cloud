import { requireSession } from "@/lib/auth";
import { AgentCreationWizard } from "./AgentCreationWizard";

export default async function NewAgentPage() {
  await requireSession();
  return <AgentCreationWizard />;
}
