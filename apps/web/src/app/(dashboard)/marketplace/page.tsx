import { requireSession } from "@/lib/auth";
import { MarketplaceClient } from "./MarketplaceClient";

export default async function MarketplacePage() {
  await requireSession();
  return <MarketplaceClient />;
}
