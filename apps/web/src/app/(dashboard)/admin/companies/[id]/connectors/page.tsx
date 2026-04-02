import { requireAdmin } from "@/lib/auth";
import { ConnectorsClient } from "./ConnectorsClient";

export default async function ConnectorsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = (await params);
  return <ConnectorsClient companyId={id} />;
}
