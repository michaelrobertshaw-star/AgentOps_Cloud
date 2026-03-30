import { getWsService, type WsEvent } from "../services/wsService.js";

// ---------------------------------------------------------------------------
// Helper: build a WsEvent
// ---------------------------------------------------------------------------

function makeEvent(type: string, channel: string, data: unknown): WsEvent {
  return {
    type,
    channel,
    data,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Task events
// ---------------------------------------------------------------------------

/**
 * Broadcast a task status change to:
 *   - company:{companyId}
 *   - department:{departmentId}
 *   - task:{taskId}
 */
export function emitTaskStatusChanged(
  taskId: string,
  departmentId: string,
  companyId: string,
  status: string,
): void {
  const ws = getWsService();
  const data = { taskId, departmentId, companyId, status };

  ws.broadcast(`company:${companyId}`, makeEvent("task.status_changed", `company:${companyId}`, data));
  ws.broadcast(`department:${departmentId}`, makeEvent("task.status_changed", `department:${departmentId}`, data));
  ws.broadcast(`task:${taskId}`, makeEvent("task.status_changed", `task:${taskId}`, data));
}

// ---------------------------------------------------------------------------
// Agent events
// ---------------------------------------------------------------------------

/**
 * Broadcast an agent status change to:
 *   - company:{companyId}
 *   - agent:{agentId}
 */
export function emitAgentStatusChanged(
  agentId: string,
  companyId: string,
  status: string,
): void {
  const ws = getWsService();
  const data = { agentId, companyId, status };

  ws.broadcast(`company:${companyId}`, makeEvent("agent.status_changed", `company:${companyId}`, data));
  ws.broadcast(`agent:${agentId}`, makeEvent("agent.status_changed", `agent:${agentId}`, data));
}

// ---------------------------------------------------------------------------
// Incident events
// ---------------------------------------------------------------------------

/**
 * Broadcast an incident creation to:
 *   - company:{companyId}
 *   - department:{departmentId}
 */
export function emitIncidentCreated(
  incidentId: string,
  departmentId: string,
  companyId: string,
  severity: string,
): void {
  const ws = getWsService();
  const data = { incidentId, departmentId, companyId, severity };

  ws.broadcast(`company:${companyId}`, makeEvent("incident.created", `company:${companyId}`, data));
  ws.broadcast(`department:${departmentId}`, makeEvent("incident.created", `department:${departmentId}`, data));
}
