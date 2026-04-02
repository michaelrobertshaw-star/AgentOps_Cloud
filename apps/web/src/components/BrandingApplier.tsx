"use client";

import { useEffect, useState } from "react";
import { fetchWithTenant } from "@/lib/fetchWithTenant";

interface BrandingConfig {
  primaryColor?: string | null;
  logoUrl?: string | null;
  companyName?: string | null;
}

interface Props {
  onBrandingLoaded?: (branding: BrandingConfig) => void;
}

export function BrandingApplier({ onBrandingLoaded }: Props) {
  useEffect(() => {
    fetchWithTenant("/api/tenant/branding")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: BrandingConfig | null) => {
        if (data) {
          if (data.primaryColor) {
            document.documentElement.style.setProperty("--brand-primary", data.primaryColor);
          }
          onBrandingLoaded?.(data);
        }
      })
      .catch(() => {/* ignore branding load errors */});
  }, []);

  return null;
}

/**
 * TenantLogo — displays the tenant logo or company name in the header.
 * Fetches branding on mount and applies CSS custom properties.
 */
export function TenantBrandHeader() {
  const [branding, setBranding] = useState<BrandingConfig | null>(null);

  useEffect(() => {
    fetchWithTenant("/api/tenant/branding")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: BrandingConfig | null) => {
        if (data) {
          setBranding(data);
          if (data.primaryColor) {
            document.documentElement.style.setProperty("--brand-primary", data.primaryColor);
          }
        }
      })
      .catch(() => {});
  }, []);

  if (branding?.logoUrl) {
    return (
      <img
        src={branding.logoUrl}
        alt={branding.companyName ?? "Logo"}
        className="h-8 w-auto object-contain"
      />
    );
  }

  return (
    <span className="text-lg font-bold text-gray-900">
      {branding?.companyName ?? "AgentOps"}
    </span>
  );
}
