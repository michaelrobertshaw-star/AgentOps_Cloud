import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  issueAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  verifyRefreshToken,
} from "./authService.js";

describe("authService", () => {
  describe("password hashing", () => {
    it("hashes and verifies a password", async () => {
      const hash = await hashPassword("test-password-123");
      expect(hash).not.toBe("test-password-123");
      expect(hash.startsWith("$2b$")).toBe(true);

      const valid = await verifyPassword("test-password-123", hash);
      expect(valid).toBe(true);

      const invalid = await verifyPassword("wrong-password", hash);
      expect(invalid).toBe(false);
    });
  });

  describe("JWT tokens", () => {
    it("issues and verifies an access token", async () => {
      const token = await issueAccessToken(
        "user-123",
        "company-456",
        ["oneops_admin"],
        { "dept-1": "department_manager" },
      );

      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(3); // JWT has 3 parts

      const payload = await verifyAccessToken(token);
      expect(payload.sub).toBe("user:user-123");
      expect(payload.company_id).toBe("company-456");
      expect(payload.roles).toEqual(["oneops_admin"]);
      expect(payload.department_roles).toEqual({ "dept-1": "department_manager" });
    });

    it("issues and verifies a refresh token", async () => {
      const { token, tokenId } = await issueRefreshToken("user-123", "company-456");

      expect(typeof token).toBe("string");
      expect(typeof tokenId).toBe("string");

      const payload = await verifyRefreshToken(token);
      expect(payload.sub).toBe("user:user-123");
      expect(payload.company_id).toBe("company-456");
      expect(payload.token_id).toBe(tokenId);
    });

    it("rejects a tampered token", async () => {
      const token = await issueAccessToken("user-123", "company-456", ["customer_user"], {});
      const tampered = token.slice(0, -5) + "xxxxx";

      await expect(verifyAccessToken(tampered)).rejects.toThrow();
    });
  });
});
