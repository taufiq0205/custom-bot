"""Durable turn worker: short transactional claims/transitions, bounded leases, no replay after interruption.
Each turn runs its pinned published workflow within fixed budgets and the 60-second deadline."""
import http.client
import ipaddress
import json
import os
import re
import signal
import socket
import ssl
import sys
import threading
import time
import uuid
from urllib.parse import parse_qsl, urlencode, urlsplit
import psycopg
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MODE = os.environ.get('APP_MODE', 'local')
if MODE not in ('local', 'test', 'hosted'):
    sys.exit('APP_MODE must be local, test or hosted')
if MODE != 'test' and any(name in os.environ for name in ('TEST_JOB_LEASE_SECONDS', 'TEST_PROVIDER_URL', 'TEST_CA_FILE', 'TEST_PUBLIC_HOSTS')):
    sys.exit('Test job controls are test-only')
# Business action credentials are AES-256-GCM ciphertext in the database; this key never is. Unset: no credential can be used.
KEY = os.environ.get('ACTION_CREDENTIAL_KEY', '')
if KEY and not re.fullmatch(r'[0-9a-fA-F]{64}', KEY):
    sys.exit('ACTION_CREDENTIAL_KEY must be 64 hex characters (openssl rand -hex 32)')
CIPHER = AESGCM(bytes.fromhex(KEY)) if KEY else None
# Test only: these exact fixture hostnames may resolve to the Docker network's private addresses. Every other check still applies.
PUBLIC_HOSTS = set(filter(None, os.environ.get('TEST_PUBLIC_HOSTS', '').split(',')))
# The lease covers the claim and each bounded external call, never past the 60-second deadline.
LEASE = int(os.environ.get('TEST_JOB_LEASE_SECONDS', '60'))
if not 1 <= LEASE <= 60:
    sys.exit('Invalid job lease')
# Test only: agents whose model is "fixture" call this controlled provider, trusted through the test CA.
PROVIDER = os.environ.get('TEST_PROVIDER_URL')
TLS = ssl.create_default_context(cafile=os.environ.get('TEST_CA_FILE'))
DATABASE = os.environ['DATABASE_URL']
WORKER = f'{os.uname().nodename}-{uuid.uuid4()}'
HOLD = re.compile(r'^\[hold (\d{1,2})s\]')
FIELD = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,63}$')
MAX_STEPS, MAX_AGENT_CALLS, MAX_HTTP_CALLS, HTTP_TIMEOUT, MAX_BODY = 20, 3, 5, 15, 262144
SIMULATED = ('Simulated reply: no AI model generated this text, and it contains no business facts. '
             'Connected generation is not configured for this conversation.')
INTERRUPTED = ('This message was interrupted before a reply and was not retried automatically. '
               'Send it again if you still need help.')
UNAVAILABLE = 'This message was not answered because connected generation is unavailable.'
FAILED = 'This message could not be answered automatically, so it has been passed to support.'
EXHAUSTED = 'This message reached the automated assistant\'s limits before an answer, so it has been passed to support.'
SESSION_ENDED = 'This message was not answered because its chat session ended (sign-out, account switch or expiry).'
SIGN_IN = 'To continue, please sign in on this website so I can confirm the order is yours.'
UNVERIFIED = 'verified Customer required'
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


def identity_current(connection, message_id):
    """The submitting session is still live and still the conversation's identity.
    Take this share lock before the conversation lock (the API's order), so identity changes and results serialize without deadlock."""
    return connection.execute(
        "SELECT 1 FROM messages m JOIN chat_sessions s ON s.id=m.session_id JOIN conversations c ON c.id=m.conversation_id "
        "WHERE m.id=%s AND s.ended_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp()) "
        "AND c.customer_id IS NOT DISTINCT FROM s.customer_id FOR SHARE OF s", (message_id,)).fetchone()


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
            "SELECT j.id,j.conversation_id,j.message_id FROM jobs j JOIN messages m ON m.id=j.message_id "
            "WHERE j.status='queued' AND j.deadline>clock_timestamp() AND NOT EXISTS("
            "SELECT 1 FROM jobs e JOIN messages em ON em.id=e.message_id WHERE e.conversation_id=j.conversation_id "
            "AND (e.status='running' OR (e.status='queued' AND em.seq<m.seq))) "
            "ORDER BY m.seq LIMIT 1").fetchone()
        if not candidate:
            return None
        identity = identity_current(connection, candidate[2])
        connection.execute('SELECT 1 FROM conversations WHERE id=%s FOR UPDATE', (candidate[1],))
        job = connection.execute(
            "UPDATE jobs SET status='running', lease_owner=%s, attempts=attempts+1, "
            "lease_expires_at=least(clock_timestamp()+make_interval(secs => %s), deadline) "
            "WHERE id=%s AND status='queued' AND deadline>clock_timestamp() AND NOT EXISTS("
            "SELECT 1 FROM jobs r WHERE r.conversation_id=jobs.conversation_id AND r.status='running') "
            "AND EXISTS(SELECT 1 FROM conversations c WHERE c.id=jobs.conversation_id AND c.control_state='automated' "
            "AND c.execution_generation=jobs.execution_generation) "
            "RETURNING id,business_id,conversation_id,message_id,execution_generation,"
            "extract(epoch FROM deadline-clock_timestamp())::float",
            (WORKER, LEASE, candidate[0])).fetchone()
        if job and not identity:
            fail(connection, job, SESSION_ENDED, 'session ended before start')
            return False
        if job:
            connection.execute("UPDATE messages SET turn_state='running' WHERE id=%s", (job[3],))
            # Anchor the deadline locally at claim time.
            job = (*job[:5], time.monotonic() + job[5])
        return job


class Lost(Exception):
    """The turn lost its authority (control change, lease or session); nothing more may run or be delivered."""


class Stop(Exception):
    """The turn fails visibly and hands off to support."""
    def __init__(self, notice, error):
        super().__init__(error)
        self.notice, self.error = notice, error


class Clarify(Exception):
    pass


class Transient(Exception):
    pass


class Rejected(Exception):
    """A non-retryable call failure: authentication, validation, redirects or malformed results."""


def current(connection, job, controls=False):
    """Inside a transaction: lock the session, then the conversation, then require this worker's live lease at the job's generation.
    An ended session fails the turn visibly. Later slices add source, consent and deletion checks here.
    With controls, a Business share lock (taken before the conversation, as the inbox does) makes Owner action-control changes
    wait for the action checks that follow."""
    identity = identity_current(connection, job[3])
    if controls:
        connection.execute('SELECT 1 FROM businesses WHERE id=%s FOR SHARE', (job[1],))
    connection.execute('SELECT 1 FROM conversations WHERE id=%s FOR UPDATE', (job[2],))
    held = connection.execute(
        "SELECT 1 FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.id=%s AND j.status='running' "
        "AND j.lease_owner=%s AND j.lease_expires_at>clock_timestamp() AND c.execution_generation=%s "
        "AND c.control_state='automated' FOR UPDATE OF j", (job[0], WORKER, job[4])).fetchone()
    if not held:
        print(f'Job {job[0]} late result discarded', flush=True)
        return False
    if not identity:
        fail(connection, job, SESSION_ENDED, 'session ended')
        print(f'Job {job[0]} result discarded: chat session ended', flush=True)
        return False
    return True


def origin(url):
    return f"https://{url.hostname}{'' if url.port in (None, 443) else f':{url.port}'}"


def authorize(connection, job, action, secret=False):
    """Inside the turn's revalidation transaction: the live controls this action needs right now, whichever path requested it
    (explicit HTTP step or agent). Returns a grant, or a value-free denial reason. Live controls override the pinned version.
    Only an attempt asks for the secret; rechecks compare revisions, which every rotation or revocation changes."""
    business, url = job[1], urlsplit(action['url'])
    if connection.execute('SELECT 1 FROM action_revocations WHERE business_id=%s AND action_id=%s', (business, action['id'])).fetchone():
        return 'action revoked'
    credential = connection.execute('SELECT origin,header,ciphertext,revision FROM action_credentials WHERE business_id=%s AND ref=%s AND active',
                                    (business, action['credential'])).fetchone()
    if not credential:
        return 'credential unavailable'
    # A credential is only ever sent to its approved origin.
    if url.scheme != 'https' or origin(url) != credential[0]:
        return 'destination not approved'
    policy = connection.execute('SELECT customer_parameter,owner_field,revision FROM authorization_policies WHERE business_id=%s AND ref=%s AND active',
                                (business, action['authorization'])).fetchone()
    if not policy:
        return 'authorization policy unavailable'
    # The verified Customer's ID is never an input: nothing else may supply that parameter.
    if policy[0] in action['input_schema']['properties'] or policy[0] in dict(parse_qsl(url.query, keep_blank_values=True)):
        return 'input collides with the Customer parameter'
    subject = connection.execute('SELECT u.external_id FROM conversations c JOIN customers u ON u.business_id=c.business_id AND u.id=c.customer_id '
                                 'WHERE c.id=%s', (job[2],)).fetchone()
    if not subject:
        return UNVERIFIED
    grant = {'parameter': policy[0], 'subject': subject[0], 'owner_field': policy[1], 'revisions': (credential[3], policy[2])}
    if not secret:
        return grant
    if not CIPHER:
        return 'credential key not configured'
    sealed = bytes(credential[2])
    try:
        return {**grant, 'headers': {credential[1]: CIPHER.decrypt(sealed[:12], sealed[12:], f'{business}/{action["credential"]}'.encode()).decode()}}
    except InvalidTag:
        return 'credential unreadable'


def stale(connection, job, grants):
    """Whether any accepted result's action controls were revoked or changed since; its facts may then go nowhere else."""
    return any(authorize(connection, job, action) != grant for action, grant in grants)


class Turn:
    def __init__(self, connection, job, document, history):
        self.connection, self.job, self.document, self.history = connection, job, document, history
        self.deadline = job[5]
        # Fields from verified HTTP results; agents cannot overwrite them.
        self.context, self.observed, self.steps, self.calls = {}, set(), 0, {'provider': 0, 'http': 0}
        # Grants (without secrets) behind accepted results, rechecked before their facts go to a provider or the Customer.
        self.grants = {}

    def left(self):
        # Keep half a second to record the outcome before the database deadline.
        remaining = self.deadline - time.monotonic() - 0.5
        if remaining <= 0:
            raise Stop(EXHAUSTED, 'deadline reached')
        return remaining

    def begin(self, step, kind, target, bound, action=None):
        """Revalidate the turn, its accepted results' controls (their facts are in the context this attempt may send) and an
        action's live controls; extend the lease to cover only this attempt, and record the attempt before it starts.
        Holds no transaction afterwards."""
        global alive_until
        with self.connection.transaction():
            held = current(self.connection, self.job, bool(action or self.grants))
            changed = held and stale(self.connection, self.job, self.grants.values())
            if held and not changed:
                grant = authorize(self.connection, self.job, action, secret=True) if action else None
                denied = grant if isinstance(grant, str) else None
                if not denied:
                    self.connection.execute("UPDATE jobs SET lease_expires_at=least(greatest(lease_expires_at,clock_timestamp()+make_interval(secs => %s)),deadline) "
                                            "WHERE id=%s", (bound + 2, self.job[0]))
                attempt = self.connection.execute(
                    "INSERT INTO execution_attempts(business_id,job_id,step_id,kind,target,status,error,finished_at) "
                    "VALUES(%s,%s,%s,%s,%s,%s,%s,CASE WHEN %s THEN clock_timestamp() END) RETURNING id",
                    (self.job[1], self.job[0], step, kind, target, 'failed' if denied else 'started', denied, bool(denied))).fetchone()[0]
        # Raised after commit, so a visible session-ended failure recorded by current() is kept.
        if not held:
            raise Lost()
        if changed:
            raise Stop(FAILED, 'action controls changed')
        if denied == UNVERIFIED:
            raise Clarify(SIGN_IN)
        if denied:
            raise Rejected(denied)
        alive_until = max(alive_until, time.monotonic() + bound + 5)
        return attempt, grant

    def end(self, attempt, status, error):
        self.connection.execute("UPDATE execution_attempts SET status=%s,error=%s,finished_at=clock_timestamp() WHERE id=%s",
                                (status, error, attempt))

    def call(self, step, target, url, body):
        """One bounded provider attempt."""
        bound = min(60, self.left())
        attempt, _ = self.begin(step, 'provider', target, bound)
        status, error = 'failed', 'aborted'
        try:
            # Lock waits above came out of the remaining time.
            result = fetch('POST', url, body, min(bound, self.left()))
            status, error = 'succeeded', None
            return result
        except (Transient, Rejected) as failure:
            error = str(failure)
            raise
        finally:
            self.end(attempt, status, error)

    def read(self, step, action, inputs):
        """One authorized read-only attempt. Its result is accepted only when it belongs to the verified Customer, matches its schema,
        and the turn and the action's live controls are unchanged; only then is it recorded and used."""
        bound = min(action['timeout_ms'] / 1000, HTTP_TIMEOUT, self.left())
        attempt, grant = self.begin(step, 'http', action['id'], bound, action)
        headers = grant.pop('headers')
        status, error = 'failed', 'aborted'
        try:
            url = urlsplit(action['url'])
            values = {**{k: json.dumps(v) if isinstance(v, bool) else v for k, v in inputs.items()}, grant['parameter']: grant['subject']}
            target = url._replace(query='&'.join(filter(None, [url.query, urlencode(values)])), fragment='').geturl()
            try:
                data = strict(fetch('GET', target, None, min(bound, self.left()), headers))
            except ValueError:
                raise Rejected('malformed result')
            # Ownership is checked independently of any order number: a foreign or unowned result discloses nothing.
            if not isinstance(data, dict) or data.get(grant['owner_field']) != grant['subject']:
                raise Rejected('result not authorized for this Customer')
            result = conform(action['result_schema'], data)
            with self.connection.transaction():
                held = current(self.connection, self.job, True)
                accepted = held and authorize(self.connection, self.job, action) == grant
                if accepted:
                    self.connection.execute("INSERT INTO lookup_results(business_id,conversation_id,job_id,step_id,action_id,result) "
                                            "VALUES(%s,%s,%s,%s,%s,%s::jsonb)", (self.job[1], self.job[2], self.job[0], step, action['id'], json.dumps(result)))
                    status, error = None, None
                    self.end(attempt, 'succeeded', None)
            if not held:
                raise Lost()
            if not accepted:
                # Revoked or changed controls defeat a delayed result.
                raise Rejected('action controls changed')
            self.grants[action['id']] = (action, grant)
            return result
        except (Transient, Rejected) as failure:
            error = str(failure)
            raise
        finally:
            if status:
                self.end(attempt, status, error)

    def retried(self, kind, attempt):
        """A transient failure retries once; every attempt, retries included, spends the budget."""
        for tries in (1, 2):
            self.calls[kind] += 1
            if self.calls[kind] > (MAX_AGENT_CALLS if kind == 'provider' else MAX_HTTP_CALLS):
                raise Stop(EXHAUSTED, 'call budget exhausted')
            try:
                return attempt()
            except Transient:
                if tries == 2:
                    raise Rejected('transient failure persisted')

    def act(self, step, action, values):
        """The one action path for explicit HTTP steps and agent requests. Missing inputs clarify; any failure returns None."""
        if not self.connection.execute('SELECT customer_id FROM conversations WHERE id=%s', (self.job[2],)).fetchone()[0]:
            # Never ask an anonymous Customer for inputs it could not use; begin() still decides authoritatively.
            raise Clarify(SIGN_IN)
        schema = action['input_schema']
        missing = [name for name in schema.get('required', []) if name not in values]
        if missing:
            raise Clarify('To continue, please tell me ' + ' and '.join(
                schema['properties'][name].get('description', name) for name in missing) + '.')
        try:
            inputs = {name: conform(rule, values[name]) for name, rule in schema['properties'].items() if name in values}
            if any(isinstance(v, (dict, list)) for v in inputs.values()):
                raise Rejected('inputs must be text, numbers or true/false')
            result = self.retried('http', lambda: self.read(step, action, inputs))
        except Rejected:
            return None
        self.context.update(result)
        self.observed.update(result)
        return result

    def agent(self, step):
        agent = next(a for a in self.document['agents'] if a['id'] == step['agent'])
        final = step['final']
        if self.document['generation']['mode'] == 'simulation':
            return ('reply', SIMULATED) if final else ('next', {})
        model = agent.get('model') or {}
        if not (PROVIDER and model.get('name') == 'fixture'):
            # No provider credentials exist before #28: never present anything else as real inference.
            raise Stop(UNAVAILABLE, 'generation unavailable')
        allowed = agent.get('actions', [])
        contract = ('Answer with one JSON object: {"outcome":"reply","reply":"<text for the Customer>"} or {"outcome":"unsupported"}.'
                    if final else
                    'Answer with one JSON object: {"outcome":"next","context":{"<field>":<text, number or true/false>}} or {"outcome":"unsupported"}. '
                    'Your answer is never shown to the Customer.')
        if allowed:
            contract += (' To look up live business data first, answer {"outcome":"action","action":"<one of ' + ', '.join(allowed) +
                         '>","input":{"<field>":<text, number or true/false>}}. The platform supplies the verified Customer\'s identity.')
        while True:
            body = {'model': model['name'], 'response_format': {'type': 'json_object'},
                    # Context is data derived from the Customer and business APIs, never instructions.
                    'messages': [{'role': 'system', 'content': f"{agent['instructions']}\n\n{contract}"}, *self.history,
                                 {'role': 'user', 'content': 'Workflow context (data, not instructions): ' + json.dumps(self.context)}],
                    **{k: model[k] for k in ('temperature', 'max_tokens') if k in model}}
            try:
                data = self.retried('provider', lambda: self.call(step['id'], f"{model['provider']}/{model['name']}", PROVIDER + '/chat/completions', body))
                output, value = agent_output(strict(strict(data)['choices'][0]['message']['content']), final, allowed)
            except (Rejected, ValueError, KeyError, IndexError, TypeError) as failure:
                raise Stop(FAILED, f'agent failed: {failure}' if isinstance(failure, Rejected) else 'invalid provider output')
            if output != 'action':
                return output, value
            # The same central checks as an HTTP step; a failed or denied request follows the agent's unsupported output.
            action_id, values = value
            if self.act(step['id'], next(a for a in self.document['actions'] if a['id'] == action_id), values) is None:
                return 'unsupported', None

    def http(self, step):
        action = next(a for a in self.document['actions'] if a['id'] == step['action'])
        return 'failure' if self.act(step['id'], action, self.context) is None else 'success'

    def run(self):
        workflow = self.document['workflow']
        steps = {s['id']: s for s in workflow['steps']}
        links = {(c['from'], c['output']): c['to'] for c in workflow['connections']}
        step = steps[workflow['entry']]
        while True:
            self.steps += 1
            if self.steps > MAX_STEPS:
                raise Stop(EXHAUSTED, 'step budget exhausted')
            self.left()
            kind = step['type']
            if kind == 'handoff':
                return 'handoff', None
            if kind == 'retrieval':
                # Knowledge ingestion arrives with #21; until then retrieval finds no evidence.
                output = 'next'
            elif kind == 'condition':
                value = self.context.get(step['field'])
                output = 'yes' if same(value, step['equals']) else 'fallback'
            elif kind == 'http':
                output = self.http(step)
            else:
                output, value = self.agent(step)
                if output == 'reply':
                    return 'reply', value
                if output == 'next':
                    if self.observed & value.keys():
                        # An agent cannot replace a verified business result with its own value.
                        raise Stop(FAILED, 'agent tried to overwrite an observed result')
                    self.context.update(value)
            step = steps[links[(step['id'], output)]]


def same(a, b):
    """Structured equality: true is not 1, and 1 equals 1.0."""
    def number(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    return (number(a) and number(b) or type(a) is type(b)) and a == b


def strict(raw):
    """Parse JSON text, rejecting NaN/Infinity."""
    def reject(_):
        raise ValueError('non-finite number')
    if not isinstance(raw, (str, bytes)):
        return raw
    try:
        return json.loads(raw, parse_constant=reject)
    except RecursionError:
        raise ValueError('nested too deeply')


def conform(rule, value):
    """The configuration's JSON Schema subset; undeclared object properties are dropped, everything else must match."""
    kind = rule['type']
    if kind == 'object':
        if not isinstance(value, dict) or any(name not in value for name in rule.get('required', [])):
            raise Rejected('result does not match its schema')
        return {k: conform(r, value[k]) for k, r in rule['properties'].items() if k in value}
    if kind == 'array':
        if not isinstance(value, list):
            raise Rejected('result does not match its schema')
        return [conform(rule['items'], v) for v in value]
    ok = {'string': isinstance(value, str), 'boolean': isinstance(value, bool),
          'integer': isinstance(value, int) and not isinstance(value, bool),
          'number': isinstance(value, (int, float)) and not isinstance(value, bool)}[kind]
    if not ok:
        raise Rejected('result does not match its schema')
    return value


def flat(values):
    return (isinstance(values, dict) and len(values) <= 20
            and all(FIELD.match(k) and (isinstance(v, (bool, int, float)) or (isinstance(v, str) and len(v) <= 500)) for k, v in values.items()))


def agent_output(data, final, allowed=()):
    """Only a final agent may produce Customer text; intermediate agents yield flat structured context.
    Any agent may request one of its permitted actions with flat inputs."""
    if not isinstance(data, dict):
        raise ValueError('not an object')
    if data == {'outcome': 'unsupported'}:
        return 'unsupported', None
    reply = data.get('reply')
    if final and set(data) == {'outcome', 'reply'} and data['outcome'] == 'reply' and isinstance(reply, str) and reply.strip() and len(reply) <= 4000:
        return 'reply', reply
    if not final and set(data) == {'outcome', 'context'} and data['outcome'] == 'next' and flat(data['context']):
        return 'next', data['context']
    if set(data) == {'outcome', 'action', 'input'} and data['outcome'] == 'action' and isinstance(data['action'], str) and data['action'] in allowed and flat(data['input']):
        return 'action', (data['action'], data['input'])
    raise ValueError('outcome does not match the agent contract')


def fetch(method, url, body, seconds, headers=None):
    """One HTTPS request under a wall-clock bound covering DNS, connect, headers and body. Redirects are never followed.
    Business requests (those carrying credential headers) go only to vetted public addresses."""
    box = {}

    def attempt():
        try:
            box['value'] = request(method, url, body, time.monotonic() + seconds, headers)
        except BaseException as failure:
            box['error'] = failure
    worker = threading.Thread(target=attempt, daemon=True)
    worker.start()
    worker.join(seconds)
    if worker.is_alive():
        # The abandoned thread stops at its own deadline check or socket timeout; its result is never read.
        raise Transient('timed out')
    if 'error' in box:
        failure = box['error']
        if isinstance(failure, ssl.SSLCertVerificationError):
            raise Rejected('certificate rejected')
        raise failure if isinstance(failure, (Transient, Rejected)) else Transient('connection failed')
    return box['value']


def vetted(host, port):
    """Resolve on every attempt and allow only public addresses: an approved hostname cannot reach private, loopback,
    link-local or other non-global networks. The connection then uses only these addresses, so a second lookup cannot change them."""
    addresses = [info[4][0] for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]
    for address in addresses:
        ip = ipaddress.ip_address(address.split('%')[0])
        ip = getattr(ip, 'ipv4_mapped', None) or ip
        if (not ip.is_global or ip.is_multicast) and host not in PUBLIC_HOSTS:
            raise Rejected('destination address not permitted')
    return addresses


class Pinned(http.client.HTTPSConnection):
    """HTTPS to an already vetted address, verifying the certificate for the hostname."""
    def __init__(self, host, port, addresses, **options):
        super().__init__(host, port, **options)
        self.addresses = addresses

    def connect(self):
        # Each vetted address in resolver order, like create_connection does for a hostname.
        for address in self.addresses:
            try:
                sock = socket.create_connection((address, self.port), self.timeout)
                break
            except OSError as failure:
                error = failure
        else:
            raise error
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def request(method, url, body, deadline, headers=None):
    parts = urlsplit(url)
    port, options = parts.port or 443, {'timeout': deadline - time.monotonic(), 'context': TLS}
    connection = (Pinned(parts.hostname, port, vetted(parts.hostname, port), **options) if headers is not None
                  else http.client.HTTPSConnection(parts.hostname, port, **options))
    try:
        payload = json.dumps(body).encode() if body is not None else None
        path = parts.path + (f'?{parts.query}' if parts.query else '')
        connection.request(method, path or '/', body=payload, headers={'accept': 'application/json', **({'content-type': 'application/json'} if payload else {}), **(headers or {})})
        response = connection.getresponse()
        if response.status == 429 or response.status >= 500:
            raise Transient(f'status {response.status}')
        if not 200 <= response.status < 300:
            raise Rejected(f'status {response.status}')
        data = bytearray()
        while chunk := response.read1(65536):
            data += chunk
            if len(data) > MAX_BODY:
                raise Rejected('response too large')
            if time.monotonic() > deadline:
                raise Transient('timed out')
        try:
            return bytes(data).decode()
        except UnicodeDecodeError:
            raise Rejected('response is not text')
    finally:
        connection.close()


def finish(connection, job, outcome, text=None, grants=()):
    """Accept the turn's result only while it still holds authority; a failure or handoff step hands off in the same transaction."""
    with connection.transaction():
        if not current(connection, job, bool(grants)):
            return
        if outcome == 'reply' and stale(connection, job, grants):
            # A reply may carry looked-up facts: a revoked or changed action defeats it, too.
            outcome, text = 'stop', Stop(FAILED, 'action controls changed before delivery')
        if outcome == 'stop':
            fail(connection, job, text.notice, text.error)
            # The control trigger pauses the conversation's remaining turns.
            connection.execute("UPDATE conversations SET control_state='waiting-for-support', handoff_reason='automation-failure' "
                               "WHERE id=%s", (job[2],))
            return
        connection.execute("UPDATE jobs SET status='completed', lease_owner=NULL WHERE id=%s", (job[0],))
        connection.execute("UPDATE messages SET turn_state='completed' WHERE id=%s", (job[3],))
        if text:
            connection.execute("INSERT INTO messages(id,business_id,conversation_id,author,text,simulated,reply_to) "
                               "VALUES(gen_random_uuid(),%s,%s,'assistant',%s,%s,%s)", (job[1], job[2], text, text == SIMULATED, job[3]))
        connection.execute("UPDATE conversations SET last_message_at=clock_timestamp() WHERE id=%s", (job[2],))
        if outcome == 'handoff':
            connection.execute("UPDATE conversations SET control_state='waiting-for-support', handoff_reason='workflow-handoff' "
                               "WHERE id=%s", (job[2],))


def run(connection, job):
    # Plain autocommit reads; no transaction stays open during held or external steps.
    message, seq, document = connection.execute(
        "SELECT m.text, m.seq, p.document FROM messages m JOIN conversations c ON c.id=m.conversation_id "
        "JOIN published_configurations p ON p.business_id=c.business_id AND p.version=c.configuration_version "
        "WHERE m.id=%s", (job[3],)).fetchone()
    history = [{'role': 'user' if author == 'customer' else 'assistant', 'content': text} for author, text in reversed(connection.execute(
        "SELECT author,text FROM messages WHERE conversation_id=%s AND seq<=%s AND author IN ('customer','assistant','operator') "
        "ORDER BY seq DESC LIMIT 20", (job[2], seq)).fetchall())]
    hold = HOLD.match(message) if MODE == 'test' else None
    if hold:
        time.sleep(min(int(hold[1]), 30))
    turn = Turn(connection, job, document, history)
    try:
        outcome, text = turn.run()
    except Lost:
        return
    except Clarify as clarification:
        outcome, text = 'reply', str(clarification)
    except Stop as stop:
        outcome, text = 'stop', stop
    finish(connection, job, outcome, text, list(turn.grants.values()))


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
                elif job is None:
                    # ponytail: 250 ms polling and one in-flight turn per worker; add LISTEN/NOTIFY or concurrency when load tests need it.
                    time.sleep(0.25)
    except psycopg.Error:
        print('Worker lost its database connection; retrying', flush=True)
        time.sleep(2)
