import { randomUUID } from 'node:crypto';
import { mode, pool } from './config.js';
if (mode === 'hosted') throw new Error('Demo seeding is disabled in hosted mode');
const email = process.env.SEED_OWNER_EMAIL;
if (!email) throw new Error('Set SEED_OWNER_EMAIL to an existing verified Operator');
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(130014)');
  const operator = await client.query('SELECT id FROM "user" WHERE email=$1 AND "emailVerified"=true', [email.toLowerCase()]);
  if (!operator.rowCount) throw new Error('Register and verify SEED_OWNER_EMAIL first');
  for (const name of ['Northstar Demo', 'Harbor Demo']) {
    if ((await client.query('SELECT 1 FROM demo_seeds WHERE name=$1', [name])).rowCount) continue;
    const id = randomUUID();
    await client.query('INSERT INTO businesses(id,name) VALUES($1,$2)', [id,name]);
    await client.query('INSERT INTO memberships(business_id,operator_id,role) VALUES($1,$2,\'Owner\')', [id,operator.rows[0].id]);
    await client.query('INSERT INTO demo_seeds(name,business_id) VALUES($1,$2)', [name,id]);
  }
  await client.query('COMMIT');
  console.log('Demo Businesses ready; existing Businesses unchanged');
} catch (error) {await client.query('ROLLBACK'); throw error;} finally {client.release(); await pool.end();}
