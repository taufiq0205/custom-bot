"""Slice 1: database/readiness worker. Execution jobs arrive in later slices."""
import os
import time
import psycopg

while True:
    try:
        with psycopg.connect(os.environ['DATABASE_URL']) as connection:
            connection.execute("INSERT INTO worker_health(id,heartbeat) VALUES('worker',now()) ON CONFLICT(id) DO UPDATE SET heartbeat=now()")
    except psycopg.Error:
        print('Worker waiting for migrations/database; check migrate and db services', flush=True)
    time.sleep(2)
