// Website chat widget, embedded on a Business website with:
// <script src="https://APP/widget.js" data-business="BUSINESS_ID" data-assertion="SIGNED_JWT_IF_SIGNED_IN" defer></script>
// The website's backend renders a fresh signed assertion on every page for a signed-in Customer, and omits it when signed out,
// so sign-in, sign-out and account switching reach chat on the next page load (docs/customer-identity.md).
// It runs on the Business's page, so it renders text only (never HTML) and sends no cookies.
(() => {
  const script = document.currentScript;
  const api = new URL(script.src).origin, business = script.dataset.business;
  let assertion = script.dataset.assertion || null;
  const key = `custom-bot-chat:${business}`;
  const el = (tag, props = {}, ...children) => {const node = Object.assign(document.createElement(tag), props); node.append(...children); return node;};
  const root = el('section', {}, el('h2', {textContent: 'Chat with us'}));
  root.setAttribute('aria-label', 'Website chat');
  root.style.cssText = 'max-width:32rem;font-family:system-ui;overflow-wrap:anywhere';
  const notice = el('p'), log = el('ol'), status = el('p'), earlier = el('ul');
  const history = el('nav', {hidden: true}, el('h3', {textContent: 'Earlier conversations'}), earlier);
  history.setAttribute('aria-label', 'Earlier conversations');
  log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite');
  status.setAttribute('role', 'status');
  const input = el('textarea', {name: 'message', maxLength: 2000, rows: 3, required: true});
  input.style.cssText = 'display:block;width:100%;box-sizing:border-box';
  const send = el('button', {textContent: 'Send'});
  const human = el('button', {type: 'button', textContent: 'Talk to a person', hidden: true});
  const form = el('form', {}, el('label', {}, 'Message', input), send, human);
  root.append(notice, log, form, status, history);
  script.after(root);
  const load = () => {try {return JSON.parse(localStorage.getItem(key)) ?? {};} catch {return {};}};
  // Only identity changes (force) may replace a newer session another tab stored; other writes would resurrect a rotated token.
  const save = force => {try {if (force || [undefined, state.token].includes(load().token)) localStorage.setItem(key, JSON.stringify(state));} catch {}};
  // Unapproved websites get no CORS access, so the browser cannot tell denial from an outage.
  const unavailable = 'Chat is unavailable on this website right now.';
  let state = load(), timer, restarted = false, list = [];
  async function call(path, body) {
    const response = await fetch(`${api}/api/chat/${business}${path}`, {
      method: body ? 'POST' : 'GET', credentials: 'omit',
      headers: {'content-type': 'application/json', ...(state.token ? {authorization: `Bearer ${state.token}`} : {})},
      body: body && JSON.stringify(body)});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || 'Chat request failed'), {status: response.status});
    return data;
  }
  // An identity change replaces the whole state, including any unsent draft of the previous identity.
  const adopt = data => {state = {token: data.token ?? state.token, conversation: data.conversation.id, verified: data.verified ?? !!state.verified}; save(true);};
  const label = m => m.author === 'customer' ? 'You' : m.author === 'operator' ? 'Support' : m.author === 'system' ? 'Notice' : m.simulated ? 'Simulated assistant' : 'Assistant';
  function render(conversation) {
    notice.textContent = (conversation.mode === 'simulation'
      ? 'Simulation mode: replies are simulated. No AI model is used, and replies contain no business facts. ' : '')
      + `Configuration version ${conversation.configuration_version}.`
      + (state.verified ? ' Signed in: your earlier conversations with this business are available.' : '');
    log.replaceChildren(...conversation.messages.map(m => el('li', {},
      el('strong', {textContent: `${label(m)}: `}), m.text,
      m.turn_state === 'queued' || m.turn_state === 'running' ? ' (waiting for reply)' : m.turn_state === 'failed' ? ' (not answered)' : '')));
    const others = list.filter(c => c.id !== state.conversation);
    history.hidden = !others.length;
    earlier.replaceChildren(...others.map(c => el('li', {}, el('button', {type: 'button',
      textContent: `Open earlier conversation started ${new Date(c.created_at).toLocaleString()}`,
      onclick: () => {state.conversation = c.id; delete state.pending; save(); refresh();}}))));
    human.hidden = conversation.control_state !== 'automated';
    clearTimeout(timer);
    if (conversation.messages.some(m => m.turn_state === 'queued' || m.turn_state === 'running')) timer = setTimeout(() => refresh(false), 1000);
    // Support replies arrive while a person has (or is about to have) the conversation.
    // ponytail: idle conversations poll every 10 s so an Operator takeover shows up; push updates if this load matters.
    else timer = setTimeout(() => refresh(false), ['waiting-for-support', 'human-controlled'].includes(conversation.control_state) ? 3000 : 10000);
  }
  // Polling reloads only the open conversation; the list changes only with identity or new conversations.
  async function refresh(withList = true) {
    try {
      const conversation = await call(`/conversations/${state.conversation}`);
      if (withList) list = await call('/conversations');
      render(conversation);
      if (status.textContent === unavailable) status.textContent = '';
    } catch (error) {
      if (error.status === 401 || error.status === 404) return restart();
      status.textContent = unavailable;
      clearTimeout(timer); timer = setTimeout(refresh, 3000);
    }
  }
  // Another tab may have rotated the shared session: adopt its state. Otherwise a lost or expired
  // session starts fresh anonymous context rather than failing forever.
  function restart() {
    const stored = load();
    if (stored.token && stored.token !== state.token) {state = stored; return refresh();}
    state = {}; save(true); return start();
  }
  async function start() {
    try {
      if (state.conversation) await call(`/conversations/${state.conversation}`);
      else adopt(await call('/conversations', {}));
      if (assertion) {
        // Each assertion is single-use, so it is presented once per page load.
        const presented = assertion, shown = state.conversation; assertion = null;
        try {
          adopt(await call('/identity', {assertion: presented}));
          // The same Customer again keeps the conversation they had open.
          if ((await call('/conversations')).some(c => c.id === shown)) {state.conversation = shown; save();}
        }
        catch (error) {
          if (error.status !== 401 && error.status !== 400) throw error;
          if (state.verified) adopt(await call('/logout', {}));
          status.textContent = 'Your account could not be confirmed, so this chat is not signed in.';
        }
      } else if (state.verified) adopt(await call('/logout', {}));
      await refresh();
    } catch (error) {
      if ((error.status === 401 || error.status === 404) && !restarted) {restarted = true; return restart();}
      send.disabled = true;
      status.textContent = unavailable;
    }
  }
  // Another tab changed the shared session or open conversation (sign-out, switch, sign-in): follow it at once, so an idle tab
  // never keeps showing a previous Customer's history. This only reads, so tabs cannot loop.
  addEventListener('storage', event => {
    if (event.key !== key) return;
    const stored = load();
    if (stored.token === state.token && stored.conversation === state.conversation) return;
    clearTimeout(timer);
    state = stored;
    if (state.conversation) return refresh();
    notice.textContent = ''; log.replaceChildren(); earlier.replaceChildren(); history.hidden = true;
  });
  human.addEventListener('click', async () => {
    human.disabled = true;
    try {render(await call(`/conversations/${state.conversation}/handoff`, {})); status.textContent = '';}
    catch (error) {
      if (error.status === 401 || error.status === 404) return restart();
      status.textContent = 'Your request did not reach support. Select Talk to a person to try again.';
    } finally {human.disabled = false;}
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    // A network retry of the same text reuses its submission ID; a new message gets a new one.
    // getRandomValues also works on plain-HTTP pages, where crypto.randomUUID is unavailable.
    if (state.pending?.text !== text) {state.pending = {id: [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join(''), text}; save();}
    send.disabled = true;
    try {
      await call(`/conversations/${state.conversation}/messages`, {client_submission_id: state.pending.id, text});
      delete state.pending; save();
      input.value = ''; status.textContent = 'Message sent.';
      await refresh();
    } catch (error) {
      if (error.status === 401 || error.status === 404) {await restart(); status.textContent = 'Your chat session changed, so this message was not sent. Check the conversation, then select Send to send it.'; return;}
      status.textContent = error.status ? error.message : 'Not sent yet. Select Send to retry.';
    } finally {send.disabled = false;}
  });
  start();
})();
