'use strict';
const $ = id => document.getElementById(id);
let current;
const time = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function render(state) {
  current = state;
  $('pin').setAttribute('aria-pressed', String(state.settings.pinned));
  $('refresh').disabled = state.checking;
  $('refresh').classList.toggle('checking', state.checking);
  const remote = state.remote;
  $('title').textContent = remote ? remote.ok ? 'Connected' : 'Disconnected' : 'Checking…';
  $('signal').className = `signal ${remote ? remote.ok ? 'online' : 'offline' : 'checking'}`;
  $('dashboard').title = [new URL(state.settings.endpoint).host,
    remote ? `Public: ${remote.ok ? 'Online' : remote.detail}` : 'Checking public connection',
    state.local ? `Local server: ${state.local.ok ? 'Online' : state.local.detail}` : '',
    remote && !remote.ok ? 'Server, tunnel, or network may be unavailable.' : '',
  ].filter(Boolean).join('\n');
  tick();
}
function tick() {
  if (!current) return;
  const age = current.checkedAt ? Date.now() - current.checkedAt : Infinity;
  $('checked').textContent = current.checkedAt ? `Checked ${time(current.checkedAt)}` : 'No recent check';
  $('next').textContent = current.checking ? 'Checking…' : current.nextCheckAt ? `Next in ${Math.max(0, Math.ceil((current.nextCheckAt - Date.now()) / 1000))}s` : '—';
  if (age > 90_000 && !current.checking) {
    $('signal').className = 'signal warning';
    $('title').textContent = 'Status unknown';

  }
}
$('refresh').onclick = () => window.gop.refresh();
for (const action of ['pin', 'hide', 'open', 'quit']) $(action).onclick = () => window.gop.action(action);
$('settingsButton').onclick = () => {
  if (!current) return;
  $('endpoint').value = current.settings.endpoint;
  $('monitorLocal').checked = current.settings.monitorLocal;
  $('notifications').checked = current.settings.notifications;
  window.gop.action('settings');
  $('dashboard').hidden = true; $('settings').hidden = false; $('error').textContent = '';
};
$('back').onclick = () => { window.gop.action('compact'); $('settings').hidden = true; $('dashboard').hidden = false; };
$('settings').onsubmit = async event => {
  event.preventDefault(); $('save').disabled = true;
  try {
    const result = await window.gop.save({ endpoint: $('endpoint').value, monitorLocal: $('monitorLocal').checked, notifications: $('notifications').checked });
    if (result.error) $('error').textContent = result.error;
    else $('back').click();
  } catch { $('error').textContent = 'Could not save settings. Try again.'; }
  finally { $('save').disabled = false; }
};
window.gop.subscribe(render);
window.gop.state().then(render);
setInterval(tick, 1000);
