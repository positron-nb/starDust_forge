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
        let brief = ''; try { const a = JSON.parse(m.args); brief = a.path || a.pattern || a.query || a.symbol || a.command || ''; } catch (e) {}
        d.querySelector('summary').textContent = '🔧 ' + m.name + (brief ? '  ' + brief : '');
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
