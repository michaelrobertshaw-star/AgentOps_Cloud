import type { JwtPayload } from "@agentops/shared";

interface Props {
  session: JwtPayload;
}

export function CompanySwitcher({ session }: Props) {
  const companyId = session.company_id;
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-100 text-sm font-medium text-gray-700 truncate max-w-[200px]">
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-brand-600 text-xs font-bold text-white uppercase">
        {companyId.slice(0, 2)}
      </span>
      <span className="truncate">{companyId.slice(0, 8)}&hellip;</span>
    </div>
  );
}
