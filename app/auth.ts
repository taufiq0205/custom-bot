import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import nodemailer from 'nodemailer';
import { mode, origin, pool, secret, smtpHost } from './config.js';
export const mail = nodemailer.createTransport({
  host: smtpHost, port: Number(process.env.SMTP_PORT ?? 1025),
  secure: mode === 'hosted',
  ...(process.env.SMTP_USER ? {auth:{user:process.env.SMTP_USER, pass:process.env.SMTP_PASSWORD}} : {})
});
export const auth = betterAuth({
  database: pool, secret, baseURL: origin, trustedOrigins: [origin],
  emailAndPassword: {enabled: true, requireEmailVerification: true, minPasswordLength: 12, revokeSessionsOnPasswordReset: true},
  session: {expiresIn: 86400, cookieCache: {enabled: false}},
  advanced: {useSecureCookies: origin.startsWith('https://')},
  rateLimit: {enabled: true, storage: 'database', window: 60, max: 60, customRules: {'/sign-in/email': {window: 60, max: 30}}},
  logger: {level: 'error', log: () => console.error('Authentication operation failed; inspect mail/database readiness')},
  plugins: [emailOTP({
    otpLength: 8, expiresIn: mode === 'test' ? Number(process.env.TEST_OTP_TTL ?? 300) : 300,
    allowedAttempts: 5, rateLimit: {window: 60, max: 30}, storeOTP: 'hashed', disableSignUp: true, sendVerificationOnSignUp: true,
    async sendVerificationOTP({email, otp, type}) {
      await mail.sendMail({from: process.env.MAIL_FROM ?? 'support@example.test', to: email, subject: type, text: `Your ${type} code: ${otp}\nExpires shortly. Use once. If you did not request this, ignore it.`});
    }
  })]
});
