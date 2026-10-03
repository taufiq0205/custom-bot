"""Durable turn worker: short transactional claims/transitions, bounded leases, no replay after interruption."""
import os
import re
import signal
import sys
import threading
import time
import uuid
import psycopg

MODE = os.environ.get('APP_MODE', 'local')
if MODE not in ('local', 'test', 'hosted'):
    sys.exit('APP_MODE must be local, test or hosted')
if MODE != 'test' and 'TEST_JOB_LEASE_SECONDS' in os.environ:
    sys.exit('Test job controls are test-only')
# The lease never outlives the 60-second execution deadline; there is no renewal or reclaim.
LEASE = int(os.environ.get('TEST_JOB_LEASE_SECONDS', '60'))
if not 1 <= LEASE <= 60:
    sys.exit('Invalid job lease')
DATABASE = os.environ['DATABASE_URL']
WORKER = f'{os.uname().nodename}-{uuid.uuid4()}'
HOLD = re.compile(r'^\[hold (\d{1,2})s\]')
SIMULATED = ('Simulated reply: no AI model generated this text, and it contains no business facts. '
             'Connected generation is not configured for this conversation.')
INTERRUPTED = ('This message was interrupted before a reply and was not retried automatically. '
               'Send it again if you still need help.')
UNAVAILABLE = 'This message was not answered because connected generation is unavailable.'
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))


# Readiness follows the job loop: it must complete an iteration every 10 s, or finish its job within the lease.
alive_until = 0.0


def heartbeat():
    # Separate thread and connection, so long external work does not make readiness flap.
    while True:
        try:
            with psycopg.connect(DATABASE, autocommit=True) as connection:
                while True:
                    if time.monotonic() < alive_until:
                            connection.execute("INSERT INTO worker_health(id,heartbeat) VALUES('worker',now()) "
                                           "ON CONFLICT(id) DO UPDATE SET heartbeat=now()")
                    time.sleep(2)
        except psycopg.Error:
            print('Worker waiting for migrations/database; check migrate and db services', flush=True)
            time.sleep(2)


def fail(connection, job, notice, error):
    connection.execute("UPDATE jobs SET status='failed', lease_owner=NULL, error=%s WHERE id=%s", (error, job[0]))
    connection.execute("UPDATE messages SET turn_state='failed' WHERE id=%s", (job[3],))
    connection.execute("INSERT INTO messages(id,business_id,conversation_id,author,text,reply_to) "
                       "VALUES(gen_random_uuid(),%s,%s,'system',%s,%s)", (job[1], job[2], notice, job[3]))
    connection.execute("UPDATE conversations SET last_message_at=clock_timestamp() WHERE id=%s", (job[2],))


def recover(connection):
    """Expired leases and missed deadlines fail visibly; their turns are never replayed."""
    while True:
        with connection.transaction():
            expired = connection.execute(
                "SELECT j.conversation_id FROM jobs j WHERE (j.status='running' AND j.lease_expires_at<=clock_timestamp()) "
                "OR (j.status='queued' AND j.deadline<=clock_timestamp()) LIMIT 1").fetchone()
            if not expired:
                return
            connection.execute('SELECT 1 FROM conversations WHERE id=%s FOR UPDATE', expired)
            job = connection.execute(
                "SELECT id,business_id,conversation_id,message_id,status FROM jobs WHERE conversation_id=%s AND "
                "((status='running' AND lease_expires_at<=clock_timestamp()) OR (status='queued' AND deadline<=clock_timestamp())) "
                "ORDER BY created_at LIMIT 1 FOR UPDATE", expired).fetchone()
            if job:
                fail(connection, job, INTERRUPTED, 'lease expired' if job[4] == 'running' else 'deadline passed before start')
                print(f'Job {job[0]} failed without replay: lease or deadline expired', flush=True)


def claim(connection):
    with connection.transaction():
        # Oldest queued turn (by message order) whose conversation has no earlier unfinished turn.
        candidate = connection.execute(
            "SELECT j.id,j.conversation_id FROM jobs j JOIN messages m ON m.id=j.message_id "
            "WHERE j.status='queued' AND j.deadline>clock_timestamp() AND NOT EXISTS("
            "SELECT 1 FROM jobs e JOIN messages em ON em.id=e.message_id WHERE e.conversation_id=j.conversation_id "
            "AND (e.status='running' OR (e.status='queued' AND em.seq<m.seq))) "
            "ORDER BY m.seq LIMIT 1").fetchone()
        if not candidate:
            return None
        connection.execute('SELECT 1 FROM conversations WHERE id=%s FOR UPDATE', (candidate[1],))
        job = connection.execute(
            "UPDATE jobs SET status='running', lease_owner=%s, attempts=attempts+1, "
            "lease_expires_at=least(clock_timestamp()+make_interval(secs => %s), deadline) "
            "WHERE id=%s AND status='queued' AND deadline>clock_timestamp() AND NOT EXISTS("
            "SELECT 1 FROM jobs r WHERE r.conversation_id=jobs.conversation_id AND r.status='running') "
            "RETURNING id,business_id,conversation_id,message_id,execution_generation",
            (WORKER, LEASE, candidate[0])).fetchone()
        if job:
            connection.execute("UPDATE messages SET turn_state='running' WHERE id=%s", (job[3],))
        return job


def complete(connection, job, text):
    with connection.transaction():
        connection.execute('SELECT 1 FROM conversations WHERE id=%s FOR UPDATE', (job[2],))
        # Accept only while this worker still holds an unexpired lease for the current execution generation.
        current = connection.execute(
            "SELECT 1 FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.id=%s AND j.status='running' "
            "AND j.lease_owner=%s AND j.lease_expires_at>clock_timestamp() AND c.execution_generation=%s "
            "AND c.control_state='automated' FOR UPDATE OF j", (job[0], WORKER, job[4])).fetchone()
        if not current:
            print(f'Job {job[0]} late result discarded', flush=True)
            return
        if text is None:
            fail(connection, job, UNAVAILABLE, 'generation unavailable')
            return
        connection.execute("UPDATE jobs SET status='completed', lease_owner=NULL WHERE id=%s", (job[0],))
        connection.execute("UPDATE messages SET turn_state='completed' WHERE id=%s", (job[3],))
        connection.execute("INSERT INTO messages(id,business_id,conversation_id,author,text,simulated,reply_to) "
                           "VALUES(gen_random_uuid(),%s,%s,'assistant',%s,true,%s)", (job[1], job[2], text, job[3]))
        connection.execute("UPDATE conversations SET last_message_at=clock_timestamp() WHERE id=%s", (job[2],))


def run(connection, job):
    # Plain autocommit reads; no transaction stays open during the (simulated) external step.
    message, mode = connection.execute(
        "SELECT m.text, p.document->'generation'->>'mode' FROM messages m JOIN conversations c ON c.id=m.conversation_id "
        "JOIN published_configurations p ON p.business_id=c.business_id AND p.version=c.configuration_version "
        "WHERE m.id=%s", (job[3],)).fetchone()
    hold = HOLD.match(message) if MODE == 'test' else None
    if hold:
        time.sleep(min(int(hold[1]), 30))
    # No generation provider exists in this slice: never present anything else as real inference.
    complete(connection, job, SIMULATED if mode == 'simulation' else None)


threading.Thread(target=heartbeat, daemon=True).start()
while True:
    try:
        with psycopg.connect(DATABASE, autocommit=True) as connection:
            while True:
                recover(connection)
                try:
                    job = claim(connection)
                except psycopg.errors.UniqueViolation:
                    continue
                alive_until = time.monotonic() + (LEASE + 5 if job else 10)
                if job:
                    run(connection, job)
                else:
                    # ponytail: 250 ms polling and one in-flight turn per worker; add LISTEN/NOTIFY or concurrency when load tests need it.
                    time.sleep(0.25)
    except psycopg.Error:
        print('Worker lost its database connection; retrying', flush=True)
        time.sleep(2)
