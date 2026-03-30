/**
 * Integration test for MinIO workspace file storage.
 *
 * Requires a running MinIO instance (docker compose up -d).
 * Skipped automatically when S3_ENDPOINT is not reachable or in CI without MinIO.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  buildWorkspaceFileKey,
  uploadWorkspaceFile,
  downloadWorkspaceFile,
  workspaceFileExists,
  deleteWorkspaceFile,
  checkMinioHealth,
} from "./storageService.js";

const WORKSPACE_ID = "test-workspace-integration";
const FILE_PATH = "hello.txt";
const FILE_CONTENT = "Hello, MinIO workspace!";

describe("MinIO workspace file storage (integration)", () => {
  beforeAll(async () => {
    const health = await checkMinioHealth();
    if (!health.healthy) {
      console.warn("MinIO not reachable — skipping integration tests");
    }
  });

  it("health check reports healthy when MinIO is running", async () => {
    const result = await checkMinioHealth();
    if (!result.healthy) {
      // Skip gracefully when MinIO is not available (e.g. in CI without docker)
      console.warn("Skipping: MinIO not available:", result.error);
      return;
    }
    expect(result.healthy).toBe(true);
  });

  it("uploads, verifies existence, downloads, and deletes a workspace file", async () => {
    const health = await checkMinioHealth();
    if (!health.healthy) {
      console.warn("Skipping: MinIO not available:", health.error);
      return;
    }

    const key = buildWorkspaceFileKey(WORKSPACE_ID, FILE_PATH);

    // Upload
    const ref = await uploadWorkspaceFile(
      key,
      Buffer.from(FILE_CONTENT),
      "text/plain",
    );
    expect(ref).toBe(`s3://workspaces/${key}`);

    // Verify exists
    const exists = await workspaceFileExists(key);
    expect(exists).toBe(true);

    // Download and verify content
    const { body, contentType } = await downloadWorkspaceFile(key);
    expect(body.toString("utf-8")).toBe(FILE_CONTENT);
    expect(contentType).toBe("text/plain");

    // Delete
    await deleteWorkspaceFile(key);

    // Verify gone
    const existsAfterDelete = await workspaceFileExists(key);
    expect(existsAfterDelete).toBe(false);
  });
});
