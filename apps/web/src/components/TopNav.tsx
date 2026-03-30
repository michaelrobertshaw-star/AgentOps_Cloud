import { CompanySwitcher } from "./CompanySwitcher";
import { logoutAction } from "@/app/(auth)/logout/actions";
import type { JwtPayload } from "@agentops/shared";

interface Props {
  session: JwtPayload;
}

export function TopNav({ session }: Props) {
  return (
    <header className="h-14 shrink-0 flex items-center justify-between bg-white border-b border-gray-200 px-4">
      <div className="flex items-center gap-4">
        <span className="text-lg font-bold text-gray-900">AgentOps</span>
        <CompanySwitcher session={session} />
      </div>

      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-600">{session.sub.replace("user:", "")}</span>
        <form action={logoutAction}>
          <button
            type="submit"
            className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
