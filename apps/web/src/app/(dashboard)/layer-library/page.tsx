import { requireSession } from "@/lib/auth";
import { LayerLibraryClient } from "./LayerLibraryClient";

export default async function LayerLibraryPage() {
  await requireSession();
  return <LayerLibraryClient />;
}
