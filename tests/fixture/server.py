"""Test-only controlled external fixture: an OpenAI-compatible provider and a business HTTPS endpoint.
Tests script responses per key on the plain control port and read back what the worker sent.
cert.pem/key.pem are a self-signed test-only CA for *.fixture.test; they protect nothing."""
import json
import re
import select
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlsplit

scripts, log, lock = {}, [], threading.Lock()


def take(key):
    with lock:
        queue = scripts.get(key) or []
        return queue.pop(0) if queue else {'status': 400, 'raw': 'unscripted fixture request'}


class Fixture(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def wait(self, seconds, entry):
        """Delay the response; record when the client gives up instead of waiting."""
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([self.connection], [], [], 0.05)[0]:
                try:
                    data = self.connection.recv(1)
                except (OSError, ssl.SSLError):
                    data = b''
                if not data:
                    entry['closed'] = round(time.time() - entry['at'], 2)
                    return False
        return True

    def respond(self, key, kind, body):
        url = urlsplit(self.path)
        entry = {'key': key, 'kind': kind, 'path': url.path, 'query': dict(parse_qsl(url.query)), 'body': body,
                 'headers': {k.lower(): v for k, v in self.headers.items()}, 'at': time.time(), 'closed': None}
        with lock:
            log.append(entry)
        script = take(key)
        if not self.wait(script.get('delay', 0), entry):
            return
        raw = script.get('raw')
        if raw is None and kind == 'provider':
            raw = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': script['content']}}]})
        if raw is None and script.get('owner'):
            # The requesting Customer's own record: copy the platform-supplied customer parameter into the owner field.
            raw = json.dumps({**script['json'], script['owner']: entry['query'].get('customer')})
        if raw is None:
            raw = json.dumps(script.get('json', {}))
        data = raw.encode()
        try:
            self.send_response(script.get('status', 200))
            for name, value in script.get('headers', {}).items():
                self.send_header(name, value)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(data) + 10 ** 6 if script.get('trickle') else len(data)))
            self.end_headers()
            if script.get('trickle'):
                # One byte a second, so per-read socket timeouts never fire.
                for _ in range(int(script['trickle'])):
                    self.wfile.write(b' ')
                    self.wfile.flush()
                    time.sleep(1)
            self.wfile.write(data)
        except (OSError, ssl.SSLError):
            entry['closed'] = round(time.time() - entry['at'], 2)

    def do_GET(self):
        self.respond(self.path.split('/')[1], 'http', None)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'null')
        if self.server.server_port == 8080:
            return self.control(body)
        system = ' '.join(m.get('content', '') for m in body.get('messages', []) if m.get('role') == 'system')
        key = re.search(r'fixture-key:(\S+)', system)
        self.respond(key[1] if key else '', 'provider', body)

    def control(self, body):
        with lock:
            if self.path == '/script':
                scripts[body['key']] = list(body['responses'])
                result = {}
            elif self.path == '/log':
                result = [e for e in log if e['key'] == body['key']]
            else:
                result = {'error': 'unknown control'}
        data = json.dumps(result).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


secure = ThreadingHTTPServer(('0.0.0.0', 443), Fixture)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain('/fixture/cert.pem', '/fixture/key.pem')
secure.socket = context.wrap_socket(secure.socket, server_side=True)
threading.Thread(target=secure.serve_forever, daemon=True).start()
ThreadingHTTPServer(('0.0.0.0', 8080), Fixture).serve_forever()
