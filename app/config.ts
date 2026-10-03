import { Pool } from 'pg';
export const mode = process.env.APP_MODE ?? 'local';
if (!['local', 'test', 'hosted'].includes(mode)) throw new Error('APP_MODE must be local, test or hosted');
function required(name: string) {
  const value = process.env[name];
  if (!value || /REPLACE|CHANGEME|placeholder/i.test(value)) throw new Error(`Set ${name}; placeholders cannot run`);
  return value;
}
export const origin = new URL(required('APP_URL')).origin;
if (mode === 'hosted' && !origin.startsWith('https://')) throw new Error('Hosted APP_URL requires HTTPS');
export const secret = required('BETTER_AUTH_SECRET');
if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must have at least 32 characters');
if (mode !== 'test' && (process.env.TEST_OTP_TTL || process.env.TEST_INVITATION_TTL)) throw new Error('Test TTL controls are test-only');
export const pool = new Pool({connectionString: required('DATABASE_URL'), max: 10, connectionTimeoutMillis: 5000});
pool.on('error', () => console.error('Database connection lost; check PostgreSQL'));
export const smtpHost = required('SMTP_HOST');
if (mode === 'hosted' && ['mail', 'localhost', '127.0.0.1'].includes(smtpHost)) throw new Error('Hosted mode requires a real SMTP transport');
