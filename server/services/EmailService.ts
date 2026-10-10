import nodemailer from 'nodemailer';

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export class EmailService {
  private static transporter: any = null;

  private static getTransporter() {
    if (this.transporter) return this.transporter;

    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
      });
    }
    return this.transporter;
  }

  public static isConfigured(): boolean {
    return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  }

  public static async sendEmail(options: EmailOptions): Promise<{ success: boolean; messageId?: string; simulated?: boolean; error?: string }> {
    const fromName = process.env.SMTP_FROM_NAME || 'CloudCast Studio';
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'broadcast@cloudcast.studio';
    const from = `"${fromName}" <${fromEmail}>`;

    const transporter = this.getTransporter();

    if (!transporter) {
      // In development or when SMTP is not configured, simulate delivery safely
      // Never log sensitive contents or tokens in logs
      console.log(`[EmailService] SMTP not configured. Simulated email delivery to [${options.to}] Subject: "${options.subject}"`);
      return { success: true, simulated: true };
    }

    try {
      const info = await transporter.sendMail({
        from,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      });
      return { success: true, messageId: info.messageId, simulated: false };
    } catch (err: any) {
      console.error(`[EmailService] Failed to send email to ${options.to}:`, err.message);
      return { success: false, error: err.message };
    }
  }

  // Email Templates
  public static getInvitationHtml(name: string, inviteUrl: string, expiresHours = 48): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #0f172a; }
    .card { max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    .header { background: #0f172a; padding: 28px; text-align: center; color: #ffffff; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
    .badge { display: inline-block; background: #ef4444; color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 9999px; margin-top: 6px; }
    .content { padding: 32px 28px; font-size: 14px; line-height: 1.6; color: #334155; }
    .btn { display: inline-block; background: #2563eb; color: #ffffff !important; text-decoration: none; padding: 12px 28px; border-radius: 10px; font-weight: 600; font-size: 14px; margin: 20px 0; text-align: center; }
    .footer { padding: 20px 28px; background: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center; }
    .mono { font-family: monospace; background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 12px; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>CloudCast Studio</h1>
      <span class="badge">BROADCAST TEAM INVITATION</span>
    </div>
    <div class="content">
      <p>Hello <strong>${name}</strong>,</p>
      <p>You have been invited to join the private live broadcasting team on <strong>CloudCast Studio</strong>.</p>
      <p>To accept your invitation and create your account password, click the button below:</p>
      <p style="text-align: center;">
        <a href="${inviteUrl}" class="btn">Set Up Your Account & Password</a>
      </p>
      <p style="font-size: 12px; color: #64748b;">This secure invitation link will expire in ${expiresHours} hours. If you were not expecting this invitation, you can safely ignore this email.</p>
      <p style="font-size: 11px; color: #94a3b8; margin-top: 24px;">Link not working? Copy and paste this URL into your browser:<br><span class="mono">${inviteUrl}</span></p>
    </div>
    <div class="footer">
      Private CloudCast Broadcast Console &bull; Automated 24/7 Live Streaming
    </div>
  </div>
</body>
</html>
    `;
  }

  public static getOtpResetHtml(name: string, otp: string, expiresMinutes = 10): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #0f172a; }
    .card { max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    .header { background: #0f172a; padding: 28px; text-align: center; color: #ffffff; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
    .badge { display: inline-block; background: #2563eb; color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 9999px; margin-top: 6px; }
    .content { padding: 32px 28px; font-size: 14px; line-height: 1.6; color: #334155; }
    .otp-box { text-align: center; margin: 24px 0; }
    .otp-code { font-family: 'SF Mono', Consolas, Menlo, monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #0f172a; background: #f1f5f9; padding: 14px 28px; border-radius: 12px; border: 1px dashed #cbd5e1; display: inline-block; }
    .footer { padding: 20px 28px; background: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>CloudCast Studio</h1>
      <span class="badge">PASSWORD RECOVERY OTP</span>
    </div>
    <div class="content">
      <p>Hello <strong>${name}</strong>,</p>
      <p>We received a request to reset your password for your CloudCast account.</p>
      <p>Here is your single-use verification code:</p>
      <div class="otp-box">
        <div class="otp-code">${otp}</div>
      </div>
      <p style="font-size: 12px; color: #64748b;">This verification code will expire in <strong>${expiresMinutes} minutes</strong> and can only be used once. If you did not request a password reset, please notify your team administrator immediately.</p>
    </div>
    <div class="footer">
      Private CloudCast Broadcast Console &bull; Security &amp; Access Protection
    </div>
  </div>
</body>
</html>
    `;
  }

  public static getPasswordChangedHtml(name: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #0f172a; }
    .card { max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; }
    .header { background: #0f172a; padding: 24px; text-align: center; color: #ffffff; }
    .content { padding: 28px; font-size: 14px; line-height: 1.6; color: #334155; }
    .footer { padding: 16px 28px; background: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1 style="margin: 0; font-size: 18px;">CloudCast Studio</h1>
    </div>
    <div class="content">
      <p>Hello <strong>${name}</strong>,</p>
      <p>This is confirmation that your password for CloudCast was changed successfully.</p>
      <p>All previously active sessions for your account have been revoked for your security.</p>
      <p style="font-size: 12px; color: #64748b;">If you did not perform this change, contact your primary owner immediately.</p>
    </div>
    <div class="footer">
      CloudCast Private Broadcast Engine
    </div>
  </div>
</body>
</html>
    `;
  }

  public static getAccountDeactivatedHtml(name: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #0f172a; }
    .card { max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; }
    .header { background: #0f172a; padding: 24px; text-align: center; color: #ffffff; }
    .content { padding: 28px; font-size: 14px; line-height: 1.6; color: #334155; }
    .footer { padding: 16px 28px; background: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1 style="margin: 0; font-size: 18px;">CloudCast Studio</h1>
    </div>
    <div class="content">
      <p>Hello <strong>${name}</strong>,</p>
      <p>Your team access to CloudCast Studio has been deactivated by an administrator.</p>
      <p>All active sessions have been terminated. Please contact your administrator if you believe this was an error.</p>
    </div>
    <div class="footer">
      CloudCast Private Broadcast Engine
    </div>
  </div>
</body>
</html>
    `;
  }
}
