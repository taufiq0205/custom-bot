// Website chat widget, embedded on a Business website with:
// <script src="https://APP/widget.js" data-business="BUSINESS_ID" defer></script>
// It runs on the Business's page, so it renders text only (never HTML) and sends no cookies.
(() => {
  const script = document.currentScript;
  const api = new URL(script.src).origin, business = script.dataset.business;
  const key = `custom-bot-chat:${business}`;
  const el = (tag, props = {}, ...children) => {const node = Object.assign(document.createElement(tag), props); node.append(...children); return node;};
  const root = el('section', {}, el('h2', {textContent: 'Chat with us'}));
  root.setAttribute('aria-label', 'Website chat');
  root.style.cssText = 'max-width:32rem;font-family:system-ui;overflow-wrap:anywhere';
  const notice = el('p'), log = el('ol'), status = el('p');
  log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite');
  status.setAttribute('role', 'status');
  const input = el('textarea', {name: 'message', maxLength: 2000, rows: 3, required: true});
  input.style.cssText = 'display:block;width:100%;box-sizing:border-box';
  const send = el('button', {textContent: 'Send'});
  const form = el('form', {}, el('label', {}, 'Message', input), send);
  root.append(notice, log, form, status);
  script.after(root);
  const load = () => {try {return JSON.parse(localStorage.getItem(key)) ?? {};} catch {return {};}};
  const save = () => {try {localStorage.setItem(key, JSON.stringify(state));} catch {}};
  // Unapproved websites get no CORS access, so the browser cannot tell denial from an outage.
  const unavailable = 'Chat is unavailable on this website right now.';
  let state = load(), timer;
  async function call(path, body) {
    const response = await fetch(`${api}/api/chat/${business}/conversations${path}`, {
      method: body ? 'POST' : 'GET', credentials: 'omit',
      headers: {'content-type': 'application/json', ...(state.token ? {authorization: `Bearer ${state.token}`} : {})},
      body: body && JSON.stringify(body)});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || 'Chat request failed'), {status: response.status});
    return data;
  }
  const label = m => m.author === 'customer' ? 'You' : m.author === 'system' ? 'Notice' : m.simulated ? 'Simulated assistant' : 'Assistant';
  function render(conversation) {
    notice.textContent = (conversation.mode === 'simulation'
      ? 'Simulation mode: replies are simulated. No AI model is used, and replies contain no business facts.'
      : 'Assistant replies may be generated.') + ` Configuration version ${conversation.configuration_version}.`;
    log.replaceChildren(...conversation.messages.map(m => el('li', {},
      el('strong', {textContent: `${label(m)}: `}), m.text,
      m.turn_state === 'queued' || m.turn_state === 'running' ? ' (waiting for reply)' : m.turn_state === 'failed' ? ' (not answered)' : '')));
    clearTimeout(timer);
    if (conversation.messages.some(m => m.turn_state === 'queued' || m.turn_state === 'running')) timer = setTimeout(refresh, 1000);
  }
  async function refresh() {
    try {render(await call(`/${state.conversation}`)); if (status.textContent === unavailable) status.textContent = '';}
    catch (error) {
      if (error.status === 401 || error.status === 404) return restart();
      status.textContent = unavailable;
      clearTimeout(timer); timer = setTimeout(refresh, 3000);
    }
  }
  // A lost session or conversation starts fresh anonymous context rather than failing forever.
  function restart() {state = {}; save(); return start();}
  async function start() {
    if (state.conversation) return refresh();
    try {
      const created = await call('', {});
      state = {token: created.token, conversation: created.conversation.id}; save();
      render(created.conversation);
    } catch (error) {
      send.disabled = true;
      status.textContent = unavailable;
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    // A network retry of the same text reuses its submission ID; a new message gets a new one.
    // getRandomValues also works on plain-HTTP pages, where crypto.randomUUID is unavailable.
    if (state.pending?.text !== text) {state.pending = {id: [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join(''), text}; save();}
    send.disabled = true;
    try {
      await call(`/${state.conversation}/messages`, {client_submission_id: state.pending.id, text});
      delete state.pending; save();
      input.value = ''; status.textContent = 'Message sent.';
      await refresh();
    } catch (error) {
      if (error.status === 401 || error.status === 404) {await restart(); status.textContent = 'Your chat session ended, so a new conversation started. Select Send to send your message.'; return;}
      status.textContent = error.status ? error.message : 'Not sent yet. Select Send to retry.';
    } finally {send.disabled = false;}
  });
  start();
})();
