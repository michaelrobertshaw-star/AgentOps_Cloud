-- Row-Level Security Policies for Multi-Tenant Isolation
-- Per ONE-3 security architecture

-- Enable RLS on all tenant-scoped tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE department_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;

-- Create a non-superuser role for the application
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agentops_app') THEN
    CREATE ROLE agentops_app LOGIN;
  END IF;
END
$$;

-- Tenant isolation policies (applied to all tenant-scoped tables)
-- These use the app.current_company_id session variable set by the application

CREATE POLICY tenant_isolation_users ON users
  USING (company_id = current_setting('app.current_company_id', true)::uuid);

CREATE POLICY tenant_isolation_departments ON departments
  USING (company_id = current_setting('app.current_company_id', true)::uuid);

CREATE POLICY tenant_isolation_dept_memberships ON department_memberships
  USING (company_id = current_setting('app.current_company_id', true)::uuid);

CREATE POLICY tenant_isolation_agents ON agents
  USING (company_id = current_setting('app.current_company_id', true)::uuid);

CREATE POLICY tenant_isolation_agent_api_keys ON agent_api_keys
  USING (company_id = current_setting('app.current_company_id', true)::uuid);

CREATE POLICY tenant_isolation_tasks ON tasks
  USING (company_id = current_setting('app.current_company_id', true)::uuid);

CREATE POLICY tenant_isolation_task_runs ON task_runs
  USING (company_id = current_setting('app.current_company_id', true)::uuid);

CREATE POLICY tenant_isolation_workspaces ON workspaces
  USING (company_id = current_setting('app.current_company_id', true)::uuid);

CREATE POLICY tenant_isolation_workspace_files ON workspace_files
  USING (company_id = current_setting('app.current_company_id', true)::uuid);

CREATE POLICY tenant_isolation_incidents ON incidents
  USING (company_id = current_setting('app.current_company_id', true)::uuid);

CREATE POLICY tenant_isolation_audit_logs ON audit_logs
  USING (company_id = current_setting('app.current_company_id', true)::uuid);

CREATE POLICY tenant_isolation_sessions ON sessions
  USING (company_id = current_setting('app.current_company_id', true)::uuid);

CREATE POLICY tenant_isolation_webhooks ON webhooks
  USING (company_id = current_setting('app.current_company_id', true)::uuid);

-- Audit logs: append-only for the application role
-- Revoke UPDATE and DELETE from the application role on audit_logs
REVOKE UPDATE, DELETE ON audit_logs FROM agentops_app;
GRANT INSERT, SELECT ON audit_logs TO agentops_app;

-- Grant full access on other tables to the application role
GRANT ALL ON users, departments, department_memberships, agents, agent_api_keys,
  tasks, task_runs, workspaces, workspace_files, incidents, sessions, webhooks
  TO agentops_app;
