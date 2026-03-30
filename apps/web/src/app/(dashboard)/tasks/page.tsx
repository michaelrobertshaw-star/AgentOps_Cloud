import { requireSession } from "@/lib/auth";
import { TasksClient } from "./TasksClient";

export default async function TasksPage() {
  await requireSession();
  return <TasksClient />;
}
