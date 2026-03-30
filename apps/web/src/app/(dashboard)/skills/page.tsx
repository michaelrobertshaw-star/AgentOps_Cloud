import { requireSession } from "@/lib/auth";
import { SkillsClient } from "./SkillsClient";

export default async function SkillsPage() {
  await requireSession();
  return <SkillsClient />;
}
