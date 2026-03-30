import nodemailer from "nodemailer";
import { getEnv } from "../config/env.js";

function getTransporter() {
  const env = getEnv();

  if (!env.SMTP_HOST) {
    // No SMTP configured — log and no-op so the server still starts in dev
    return null;
  }

  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER
      ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
      : undefined,
  });
}

export async function sendUserInviteEmail(params: {
  toEmail: string;
  toName: string;
  companyName: string;
}): Promise<void> {
  const env = getEnv();
  const transporter = getTransporter();

  if (!transporter) {
    // Dev/unconfigured — emit a console warning so engineers notice during testing
    console.warn(
      `[emailService] SMTP not configured. Invite email NOT sent to ${params.toEmail}. ` +
        `Set SMTP_HOST to enable email delivery.`,
    );
    return;
  }

  const loginUrl = `${env.APP_BASE_URL}/login`;

  await transporter.sendMail({
    from: env.SMTP_FROM,
    to: `${params.toName} <${params.toEmail}>`,
    subject: `You've been invited to ${params.companyName} on AgentOps Cloud`,
    text: [
      `Hi ${params.toName},`,
      ``,
      `You've been added to ${params.companyName} on AgentOps Cloud.`,
      ``,
      `Log in at: ${loginUrl}`,
      `Your email address: ${params.toEmail}`,
      ``,
      `If you didn't expect this invitation, you can ignore this email.`,
    ].join("\n"),
    html: `
      <p>Hi ${params.toName},</p>
      <p>You've been added to <strong>${params.companyName}</strong> on AgentOps Cloud.</p>
      <p>
        <a href="${loginUrl}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;">
          Log in to AgentOps Cloud
        </a>
      </p>
      <p>Your email address: <strong>${params.toEmail}</strong></p>
      <p style="color:#6b7280;font-size:0.875rem;">
        If you didn't expect this invitation, you can safely ignore this email.
      </p>
    `,
  });
}
