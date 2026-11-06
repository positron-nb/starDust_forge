// Webview script for the Forge agent panel. Renders streamed TrueForge events.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const log = $('log'), input = $('input'), status = $('status');
  const texts = new Map(), tools = new Map(), threads = new Map();

  function container(thread) {
    if (!thread || thread === 'main') return log;
    let t = threads.get(thread);
    if (!t) {
      t = document.createElement('details');
      t.className = 'thread'; t.open = true;
      t.innerHTML = '<summary>↳ subagent</summary>';
      log.appendChild(t); threads.set(thread, t);
    }
    return t;
  }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function el(cls, text) { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; }

  window.addEventListener('message', ({ data: m }) => {
    switch (m.kind) {
      case 'clear': log.innerHTML = ''; texts.clear(); tools.clear(); threads.clear(); status.textContent = ''; $('model').textContent = 'no session'; $('session').hidden = true; break;
      case 'user': log.appendChild(el('msg user', m.text)); break;
      case 'text': {
        let d = texts.get(m.id);
        if (!d) { d = el('msg agent', ''); container(m.thread).appendChild(d); texts.set(m.id, d); }
        d.textContent = m.text;
        break;
      }
      case 'tool': {
        let d = tools.get(m.id);
        if (!d) {
          d = document.createElement('details'); d.className = 'tool';
          d.innerHTML = '<summary></summary><pre class="args"></pre><pre class="result"></pre>';
          container(m.thread).appendChild(d); tools.set(m.id, d);
        }
        let args = m.args; try { args = JSON.stringify(JSON.parse(m.args), null, 1); } catch (e) { /* partial JSON while streaming */ }
        let name = m.name, a = {}, tag = '';
        try { a = JSON.parse(m.args) || {}; } catch (e) {}
        // TrueForge deferred tool loading: meta-tools discover/call our tools on demand.
        if (name === 'call_tool' && a.tool_name) { name = a.tool_name; a = a.input || {}; tag = ' ⟨deferred⟩'; }
        else if (['list_tools', 'get_tool_info', 'get_tool_output_schema'].includes(name)) tag = ' ⟨deferred tool loading' + (a.tool_name ? ': ' + a.tool_name : '') + '⟩';
        const brief = a.path || a.pattern || a.query || a.symbol || a.command || '';
        d.querySelector('summary').textContent = '🔧 ' + name + (brief ? '  ' + brief : '') + tag;
        d.querySelector('.args').textContent = args;
        break;
      }
      case 'toolResult': {
        const d = tools.get(m.id);
        if (d) { const r = d.querySelector('.result'); r.textContent = m.text.length > 4000 ? m.text.slice(0, 4000) + '\n…' : m.text; d.classList.add('done'); }
        break;
      }
      case 'thread': { const t = container(m.thread); t.querySelector('summary').textContent = (m.done ? '✓ ' : '↳ ') + 'subagent: ' + m.title; break; }
      case 'status': { const d = el('status ' + m.level, m.text); status.textContent = ''; status.appendChild(d); if (m.level !== 'info') log.appendChild(el('note ' + m.level, m.text)); break; }
      case 'session': $('model').textContent = m.model; const a = $('session'); a.hidden = false; a.dataset.url = m.url; a.title = m.sessionId; break;
      case 'running': $('send').disabled = m.running; $('cancel').disabled = !m.running; document.body.classList.toggle('running', m.running); break;
      case 'usage': $('usage').textContent = m.text; break;
      case 'context': {
        // Live view of the context engine: which files/symbols were chosen, why, and the budget.
        const d = document.createElement('details'); d.className = 'context'; d.open = true;
        const pct = Math.round(100 * m.used / m.budget);
        d.innerHTML = '<summary></summary><div class="bar"><span></span></div><table></table><div class="stats"></div>';
        d.querySelector('summary').textContent = '📚 Context selected for "' + (m.query.length > 60 ? m.query.slice(0, 60) + '…' : m.query) + '" — ' + m.items.length + ' items, ' + m.used + '/' + m.budget + ' tokens';
        d.querySelector('.bar span').style.width = pct + '%';
        const t = d.querySelector('table');
        for (const it of m.items) {
          const tr = document.createElement('tr');
          const a = document.createElement('td'); a.className = 'loc'; a.textContent = it.file + ':' + it.start + (it.symbol === '(outline)' ? ' (outline)' : ' ' + it.symbol);
          const b = document.createElement('td'); b.className = 'tok'; b.textContent = it.tokens + 't';
          const c = document.createElement('td'); c.className = 'why'; c.textContent = it.why;
          tr.append(a, b, c); t.appendChild(tr);
        }
        d.querySelector('.stats').textContent = m.stats;
        container('main').appendChild(d);
        break;
      }
      case 'review': {
        // Review card: mirrors the diff editor; per-hunk accept/reject, apply, undo.
        let card = document.getElementById('rv-' + m.id);
        if (!card) { card = document.createElement('div'); card.id = 'rv-' + m.id; card.className = 'review'; container('main').appendChild(card); }
        card.innerHTML = '';
        const counts = { accepted: 0, rejected: 0, pending: 0 }; m.hunks.forEach(h => counts[h.state]++);
        const head = document.createElement('div'); head.className = 'rv-head';
        head.textContent = '📝 ' + m.path + (m.isNew ? ' (new file)' : '') + ' — ' + m.hunks.length + ' hunk(s) · ' + m.status.toUpperCase() +
          (m.status === 'reviewing' ? ' · ' + counts.accepted + '✓ ' + counts.rejected + '✗ ' + counts.pending + ' pending' : '');
        card.appendChild(head);
        if (m.description) card.appendChild(el('rv-desc', m.description));
        const btn = (label, action, extra, cls) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls;
          b.onclick = () => vscode.postMessage(Object.assign({ kind: 'review', id: m.id, action }, extra || {})); return b; };
        for (const h of m.hunks) {
          const box = document.createElement('div'); box.className = 'hunk ' + h.state;
          const pre = document.createElement('pre');
          const NL = String.fromCharCode(10);
          const minus = h.removed.slice(0, 12).map(l => '- ' + l).concat(h.removed.length > 12 ? ['- …'] : []);
          const plus = h.added.slice(0, 12).map(l => '+ ' + l).concat(h.added.length > 12 ? ['+ …'] : []);
          pre.textContent = ['@@ line ' + h.origStart].concat(minus, plus).join(NL);
          box.appendChild(pre);
          if (m.status === 'reviewing') {
            const row = document.createElement('div'); row.className = 'row';
            row.append(btn('✓ Accept', 'accept', { index: h.index }, h.state === 'accepted' ? 'on' : ''), btn('✗ Reject', 'reject', { index: h.index }, h.state === 'rejected' ? 'on' : ''));
            box.appendChild(row);
          } else box.appendChild(el('rv-state', h.state));
          card.appendChild(box);
        }
        const row = document.createElement('div'); row.className = 'row';
        if (m.status === 'reviewing') row.append(btn('Accept all', 'acceptAll'), btn('Reject all', 'rejectAll'), btn('Open diff', 'open'), btn('Apply decisions', 'apply', null, 'primary'));
        if (m.status === 'applied') { const u = document.createElement('button'); u.textContent = '↶ Undo agent run'; u.onclick = () => vscode.postMessage({ kind: 'undo', action: 'run' }); row.append(u); }
        card.appendChild(row);
        break;
      }
      case 'mentions': {
        const d = el('note info', '📌 ' + m.items.map(i => '@' + i.kind + ':' + i.ref + (i.resolved ? ' → ' + i.detail : ' ✗ ' + i.detail)).join('   '));
        log.appendChild(d); break;
      }
    }
    scroll();
  });

  function send() { const t = input.value; if (!t.trim()) return; input.value = ''; vscode.postMessage({ kind: 'send', text: t }); }
  $('send').onclick = send;
  $('cancel').onclick = () => vscode.postMessage({ kind: 'cancel' });
  $('new').onclick = () => vscode.postMessage({ kind: 'new' });
  $('session').onclick = e => { e.preventDefault(); vscode.postMessage({ kind: 'open', url: e.target.dataset.url }); };
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
})();
