import { requireSession } from "@/lib/auth";
import { CompanyDetailClient } from "./CompanyDetailClient";

export default async function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  return <CompanyDetailClient companyId={id} />;
}
