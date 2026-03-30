import { requireSession } from "@/lib/auth";
import { SkillDetailClient } from "./SkillDetailClient";

export default async function SkillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  return <SkillDetailClient skillId={id} />;
}
