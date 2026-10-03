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
// Business action credentials are encrypted with this key; it never enters the database. Unset: credentials cannot be stored or used.
const credentialHex = process.env.ACTION_CREDENTIAL_KEY || '';
if (credentialHex && !/^[0-9a-f]{64}$/i.test(credentialHex)) throw new Error('ACTION_CREDENTIAL_KEY must be 64 hex characters (openssl rand -hex 32)');
export const credentialKey = credentialHex ? Buffer.from(credentialHex, 'hex') : undefined;
