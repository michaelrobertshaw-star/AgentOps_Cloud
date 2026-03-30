import type { JwtPayload, AuditRiskLevel } from "@agentops/shared";

declare global {
  namespace Express {
    interface Request {
      auth?: JwtPayload;
      companyId?: string;
      userId?: string;
      requestId?: string;
      audit?: (params: {
        action: string;
        resourceType: string;
        resourceId: string;
        departmentId?: string;
        changes?: { before?: Record<string, unknown>; after?: Record<string, unknown> };
        riskLevel?: AuditRiskLevel;
      }) => Promise<void>;
    }
  }
}
