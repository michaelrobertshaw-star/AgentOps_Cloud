import { requireSession } from "@/lib/auth";
import { NewSkillClient } from "./NewSkillClient";

export default async function NewSkillPage() {
  await requireSession();
  return <NewSkillClient />;
}
