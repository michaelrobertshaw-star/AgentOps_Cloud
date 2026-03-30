import { requireSession } from "@/lib/auth";
import { NewCompanyWizard } from "./NewCompanyWizard";

export default async function NewCompanyPage() {
  await requireSession();
  return <NewCompanyWizard />;
}
