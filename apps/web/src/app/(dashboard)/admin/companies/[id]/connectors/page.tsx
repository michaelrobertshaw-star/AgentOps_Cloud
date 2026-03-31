import { requireSession } from "@/lib/auth";
import { ConnectorsClient } from "./ConnectorsClient";

export default async function ConnectorsPage({ params }: { params: { id: string } }) {
  await requireSession();
  return <ConnectorsClient companyId={params.id} />;
}
