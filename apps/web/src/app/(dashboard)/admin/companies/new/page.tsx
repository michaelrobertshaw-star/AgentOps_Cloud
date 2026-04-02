import { requireAdmin } from "@/lib/auth";
import { NewCompanyWizard } from "./NewCompanyWizard";

export default async function NewCompanyPage() {
  await requireAdmin();
  return <NewCompanyWizard />;
}
