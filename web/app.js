/* Schulkalender Editor – Feature-Branch (ohne PR)
   Einfache Web-App zum Bearbeiten einer ICS-Datei direkt im GitHub-Repo.
   Speichert in einem neuen Feature-Branch, ohne Pull Request zu öffnen.
   Voraussetzungen:
   - GitHub PAT mit Repo-Contents-Write (oder fine-grained Token mit "Contents: Read and Write")
   - Hosting via GitHub Pages (oder lokal mit Live Server)
*/

const CONFIG = {
  OWNER: 'ulba78',
  REPO: 'schule',
  FILE_PATH: 'schulkalender-2025-2026.ics',
  BASE_BRANCH: 'main',
  FEATURE_BRANCH_PREFIX: 'edit-ics/',
  LOCALE: 'de-DE',
  TZID: 'Europe/Berlin',
};

const UI = {
  status: document.getElementById('status'),
  notice: document.getElementById('sourceNotice'),
  list: document.getElementById('list'),
  viewUpcoming: document.getElementById('viewUpcoming'),
  viewAll: document.getElementById('viewAll'),
  loadBtn: document.getElementById('loadBtn'),
  saveBtn: document.getElementById('saveBtn'),
  newBtn: document.getElementById('newBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  searchInput: document.getElementById('searchInput'),
  owner: document.getElementById('owner'),
  repo: document.getElementById('repo'),
  path: document.getElementById('path'),
  baseBranch: document.getElementById('baseBranch'),
  featurePrefix: document.getElementById('featurePrefix'),
  setTokenBtn: document.getElementById('setTokenBtn'),
  clearTokenBtn: document.getElementById('clearTokenBtn'),
  // Modal
  modalBackdrop: document.getElementById('modalBackdrop'),
  fTitle: document.getElementById('fTitle'),
  fLocation: document.getElementById('fLocation'),
  fDescription: document.getElementById('fDescription'),
  fAllDay: document.getElementById('fAllDay'),
  fStartDate: document.getElementById('fStartDate'),
  fStartTime: document.getElementById('fStartTime'),
  fEndDate: document.getElementById('fEndDate'),
  fEndTime: document.getElementById('fEndTime'),
  fUid: document.getElementById('fUid'),
  deleteBtn: document.getElementById('deleteBtn'),
  cancelBtn: document.getElementById('cancelBtn'),
  saveEventBtn: document.getElementById('saveEventBtn'),
};

let TOKEN = getToken();
let events = [];
let currentView = 'upcoming';
let editIndex = -1;

// ===== Token =====
function setToken(tok){
  TOKEN = tok;
  localStorage.setItem('gh-token', tok || '');
}
function getToken(){
  return localStorage.getItem('gh-token') || '';
}

// ===== GitHub API =====
function ghHeaders(json = true){
  const h = {
    'Authorization': `Bearer ${TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'SchulkalenderEditor/1.0'
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}
async function ghGetJson(url){
  const r = await fetch(url, { headers: ghHeaders(false) });
  if (!r.ok) throw new Error('GitHub GET failed: '+r.status);
  return await r.json();
}
async function ghPutJson(url, body){
  const r = await fetch(url, { method:'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!r.ok) { const t = await r.text(); throw new Error(`GitHub PUT failed: ${r.status} ${t}`); }
  return await r.json();
}
async function ghPostJson(url, body){
  const r = await fetch(url, { method:'POST', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!r.ok) { const t = await r.text(); throw new Error(`GitHub POST failed: ${r.status} ${t}`); }
  return await r.json();
}
async function getBranchRef(owner, repo, branch){
  const url = `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`;
  return await ghGetJson(url); // {ref, object:{sha}}
}
async function createBranch(owner, repo, branchName, fromSha){
  const url = `https://api.github.com/repos/${owner}/${repo}/git/refs`;
  return await ghPostJson(url, { ref: `refs/heads/${branchName}`, sha: fromSha });
}
async function getFile(owner, repo, path, branch){
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const json = await ghGetJson(url);
  if (!json || !json.content || !json.sha) throw new Error('File not found or invalid content response');
  const bytes = atob(json.content.replace(/\n/g,''));
  return { text: bytes, sha: json.sha };
}
async function putFile(owner, repo, path, branch, message, contentText, sha){
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const contentB64 = btoa(unescape(encodeURIComponent(contentText)));
  return await ghPutJson(url, { message, content: contentB64, branch, sha });
}
async function ensureUniqueBranchName(owner, repo, desired, baseSha){
  let name = desired; let n = 2;
  while (true) {
    try {
      await createBranch(owner, repo, name, baseSha);
      return name;
    } catch (e) {
      const msg = String(e);
      if (msg.includes('Reference already exists')) { name = desired + '-' + n; n++; continue; }
      throw e;
    }
  }
}

// ===== ICS Parsing/Serializing =====
function unfoldICS(text){
  const lines = text.replace(/\r\n/g,'\n').split('\n');
  const out = [];
  for (let i=0;i<lines.length;i++){
    let ln = lines[i];
    while (i+1 < lines.length && (lines[i+1].startsWith(' ') || lines[i+1].startsWith('\t'))){
      ln += lines[i+1].slice(1);
      i++;
    }
    out.push(ln);
  }
  return out;
}
function parseParams(prop){
  const params = {};
  if (!prop) return params;
  const parts = prop.split(';').slice(1);
  for (const p of parts){
    const [k,v] = p.split('=');
    if (k && v) params[k.toUpperCase()] = v;
  }
  return params;
}
function parseDate(val, params){
  if (!val) return null;
  if ((params && params.VALUE === 'DATE') || /^\d{8}$/.test(val)){
    const y=+val.slice(0,4), m=+val.slice(4,6)-1, d=+val.slice(6,8);
    return new Date(y,m,d,0,0,0);
  }
  if (val.endsWith('Z')) return new Date(val);
  const y = +val.slice(0,4), mo = +val.slice(4,6)-1, da = +val.slice(6,8);
  const hh = +val.slice(9,11)||0, mi = +val.slice(11,13)||0, ss = +val.slice(13,15)||0;
  return new Date(y,mo,da,hh,mi,ss);
}
function normalizeEvent(e){
  const start = parseDate(e.dtstart, e.startParams);
  if (!start || isNaN(start)) return null;
  let end = e.dtend ? parseDate(e.dtend, e.endParams) : null;
  const allDay = (e.startParams && e.startParams.VALUE==='DATE') || (/^\d{8}$/.test(e.dtstart));
  if (allDay){
    if (!end){ end = new Date(start); end.setDate(end.getDate()+1); }
  } else if (!end){
    end = new Date(start); end.setHours(end.getHours()+1);
  }
  return {
    uid: e.uid || crypto.randomUUID()+'@example.com',
    title: e.summary || 'Termin',
    description: e.description || '',
    location: e.location || '',
    start, end, allDay
  };
}
function parseICS(ics){
  const lines = unfoldICS(ics);
  const events = [];
  let cur = null;
  for (const raw of lines){
    const ln = raw.trim();
    if (!ln) continue;
    if (ln === 'BEGIN:VEVENT'){ cur = {}; continue; }
    if (ln === 'END:VEVENT'){
      if (cur && cur.dtstart){
        const ev = normalizeEvent(cur);
        if (ev) events.push(ev);
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const idx = ln.indexOf(':'); if (idx === -1) continue;
    const keypart = ln.slice(0, idx);
    const value = ln.slice(idx+1);
    const [keyRaw] = keypart.split(';');
    const key = keyRaw.toUpperCase();
    const params = parseParams(keypart);
    switch(key){
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.summary = value; break;
      case 'DESCRIPTION': cur.description = value; break;
      case 'LOCATION': cur.location = value; break;
      case 'DTSTAMP': cur.dtstamp = value; break;
      case 'DTSTART': cur.dtstart = value; cur.startParams = params; break;
      case 'DTEND': cur.dtend = value; cur.endParams = params; break;
    }
  }
  events.sort((a,b)=>a.start - b.start);
  return events;
}
function esc(s){
  return (s || '')
    .replace(/\\/g,'\\\\')
    .replace(/;/g,'\\;')
    .replace(/,/g,'\\,')
    .replace(/\n/g,'\\n');
}
function fmtDateLocal(dt){ return `${dt.getFullYear().toString().padStart(4,'0')}${(dt.getMonth()+1).toString().padStart(2,'0')}${dt.getDate().toString().padStart(2,'0')}`; }
function fmtDTLocal(dt){ return `${dt.getFullYear().toString().padStart(4,'0')}${(dt.getMonth()+1).toString().padStart(2,'0')}${dt.getDate().toString().padStart(2,'0')}T${dt.getHours().toString().padStart(2,'0')}${dt.getMinutes().toString().padStart(2,'0')}${dt.getSeconds().toString().padStart(2,'0')}`; }
function fmtStampUtc(){ const d=new Date(); return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}T${String(d.getUTCHours()).padStart(2,'0')}${String(d.getUTCMinutes()).padStart(2,'0')}${String(d.getUTCSeconds()).padStart(2,'0')}Z`; }
function serializeICS(evs){
  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Schulkalender Import//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE',
    `TZID:${CONFIG.TZID}`,
    `X-LIC-LOCATION:${CONFIG.TZID}`,
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE'
  ];
  const out = [...head];
  for (const e of evs.slice().sort((a,b)=>a.start-b.start)){
    out.push('BEGIN:VEVENT');
    out.push(`UID:${e.uid}`);
    out.push(`DTSTAMP:${fmtStampUtc()}`);
    if (e.allDay){
      out.push(`DTSTART;VALUE=DATE:${fmtDateLocal(e.start)}`);
      out.push(`DTEND;VALUE=DATE:${fmtDateLocal(e.end)}`);
    } else {
      out.push(`DTSTART;TZID=${CONFIG.TZID}:${fmtDTLocal(e.start)}`);
      out.push(`DTEND;TZID=${CONFIG.TZID}:${fmtDTLocal(e.end)}`);
    }
    out.push(`SUMMARY:${esc(e.title)}`);
    if (e.location) out.push(`LOCATION:${esc(e.location)}`);
    if (e.description) out.push(`DESCRIPTION:${esc(e.description)}`);
    out.push('END:VEVENT');
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n');
}

// ===== UI =====
function setStatus(msg){ UI.status.textContent = 'Status: ' + msg; }
function setNotice(msg){ UI.notice.textContent = msg; }
function escapeHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function formatTime(ev){
  const fmtDate = new Intl.DateTimeFormat(CONFIG.LOCALE,{weekday:'short', day:'2-digit', month:'2-digit'});
  const fmtDT = new Intl.DateTimeFormat(CONFIG.LOCALE,{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
  if (ev.allDay) return fmtDate.format(ev.start);
  const now = new Date();
  const diff = ev.start - now;
  if (diff > 0 && diff < 24*3600*1000){
    const hrs = Math.floor(diff/3600000);
    if (hrs >= 1) return `in ${hrs}h`;
    const mins = Math.max(0, Math.floor(diff/60000));
    return `in ${mins} Min`;
  }
  return fmtDT.format(ev.start);
}
function renderList(){
  const q = (UI.searchInput.value || '').trim().toLowerCase();
  const now = new Date();
  const src = events.filter(ev=>{
    if (currentView === 'upcoming' && ev.end <= now) return false;
    if (!q) return true;
    return (ev.title||'').toLowerCase().includes(q) ||
           (ev.location||'').toLowerCase().includes(q) ||
           (ev.description||'').toLowerCase().includes(q);
  }).sort((a,b)=>a.start - b.start);

  if (!src.length){
    UI.list.innerHTML = '<div class="muted">Keine Termine.</div>';
    return;
  }
  UI.list.innerHTML = src.map((ev)=> `
    <div class="item">
      <div class="time">${formatTime(ev)} ${ev.allDay?'<span class="tag">ganztägig</span>':''}</div>
      <div>
        <div class="title">${escapeHtml(ev.title)}</div>
        <div class="meta">${escapeHtml(ev.location || '')}</div>
        <div class="meta small">${escapeHtml(ev.description || '')}</div>
      </div>
      <div>
        <button data-uid="${ev.uid}" class="editBtn">Bearbeiten</button>
      </div>
    </div>
  `).join('');

  document.querySelectorAll('.editBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const uid = btn.getAttribute('data-uid');
      const idx = events.findIndex(e=>e.uid===uid);
      openModal(idx);
    });
  });
}

// ===== Modal =====
let editIndexGlobal = -1;
function openModal(idx){
  editIndexGlobal = idx;
  const ev = idx>=0 ? events[idx] : {
    uid: crypto.randomUUID() + '@example.com',
    title: '',
    description: '',
    location: '',
    start: new Date(),
    end: new Date(new Date().getTime() + 60*60*1000),
    allDay: false
  };
  UI.fTitle.value = ev.title || '';
  UI.fLocation.value = ev.location || '';
  UI.fDescription.value = ev.description || '';
  UI.fAllDay.value = ev.allDay ? 'true' : 'false';
  UI.fStartDate.valueAsDate = new Date(ev.start.getFullYear(), ev.start.getMonth(), ev.start.getDate());
  UI.fEndDate.valueAsDate = new Date(ev.end.getFullYear(), ev.end.getMonth(), ev.end.getDate());
  UI.fStartTime.value = `${String(ev.start.getHours()).padStart(2,'0')}:${String(ev.start.getMinutes()).padStart(2,'0')}`;
  UI.fEndTime.value = `${String(ev.end.getHours()).padStart(2,'0')}:${String(ev.end.getMinutes()).padStart(2,'0')}`;
  UI.fUid.textContent = 'UID: ' + ev.uid;
  toggleTimeFields();
  UI.modalBackdrop.style.display = 'flex';
  UI.modalBackdrop.setAttribute('aria-hidden','false');
}
function closeModal(){
  UI.modalBackdrop.style.display = 'none';
  UI.modalBackdrop.setAttribute('aria-hidden','true');
  editIndexGlobal = -1;
}
function toggleTimeFields(){
  const allDay = UI.fAllDay.value === 'true';
  document.getElementById('timeStartWrap').style.display = allDay ? 'none' : '';
  document.getElementById('timeEndWrap').style.display = allDay ? 'none' : '';
}
function saveEventFromForm(){
  const allDay = UI.fAllDay.value === 'true';
  const sd = UI.fStartDate.valueAsDate;
  const ed = UI.fEndDate.valueAsDate;
  if (!sd || !ed){ alert('Bitte Start- und Enddatum setzen.'); return; }

  let start = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate(), 0,0,0);
  let end   = new Date(ed.getFullYear(), ed.getMonth(), ed.getDate(), 0,0,0);
  if (!allDay){
    const [sh,sm] = (UI.fStartTime.value || '09:00').split(':').map(Number);
    const [eh,em] = (UI.fEndTime.value || '10:00').split(':').map(Number);
    start = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate(), sh||0, sm||0, 0);
    end   = new Date(ed.getFullYear(), ed.getMonth(), ed.getDate(), eh||0, em||0, 0);
  } else {
    end = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 0,0,0);
  }
  if (end <= start){ alert('Ende muss nach dem Start liegen.'); return; }

  const obj = {
    uid: (UI.fUid.textContent || '').replace('UID: ','') || (crypto.randomUUID()+'@example.com'),
    title: UI.fTitle.value.trim() || 'Termin',
    description: UI.fDescription.value.trim(),
    location: UI.fLocation.value.trim(),
    start, end, allDay
  };

  if (editIndexGlobal >= 0) events[editIndexGlobal] = obj;
  else events.push(obj);

  events.sort((a,b)=>a.start-b.start);
  closeModal();
  renderList();
}
function deleteEvent(){
  if (editIndexGlobal < 0){ return; }
  if (!confirm('Termin wirklich löschen?')) return;
  events.splice(editIndexGlobal, 1);
  closeModal();
  renderList();
}

// ===== Load/Save =====
async function doLoad(){
  setStatus('Lade aus GitHub...');
  const owner = UI.owner.value.trim(); const repo = UI.repo.value.trim();
  const path = UI.path.value.trim(); const base = UI.baseBranch.value.trim();
  try{
    if (!TOKEN){ alert('Bitte zuerst Token setzen.'); return; }
    const { text } = await getFile(owner, repo, path, base);
    events = parseICS(text);
    setNotice(`Quelle: ${owner}/${repo}@${base} – ${path}`);
    setStatus(`Geladen (${events.length} Termine)`);
    renderList();
  }catch(e){
    console.error(e);
    setStatus('Fehler beim Laden: ' + e.message);
    alert('Fehler beim Laden: ' + e.message);
  }
}
async function doSave(){
  setStatus('Erstelle Feature-Branch und speichere...');
  const owner = UI.owner.value.trim(); const repo = UI.repo.value.trim();
  const path = UI.path.value.trim(); const base = UI.baseBranch.value.trim();
  const prefix = (UI.featurePrefix.value.trim() || CONFIG.FEATURE_BRANCH_PREFIX).replace(/\/+$/,'') + '/';

  if (!TOKEN){ alert('Bitte zuerst Token setzen.'); return; }

  try{
    // 1) Aktuellen HEAD von base lesen
    const ref = await getBranchRef(owner, repo, base);
    const baseSha = ref.object.sha;

    // 2) Branch-Namen generieren und anlegen
    const dateTag = new Date().toISOString().slice(0,19).replace(/[-:T]/g,'');
    const desiredBranch = `${prefix}${dateTag}`;
    const featureBranch = await ensureUniqueBranchName(owner, repo, desiredBranch, baseSha);

    // 3) Neueste Datei aus base holen (für SHA und Konflikte)
    const latest = await getFile(owner, repo, path, base);

    // 4) ICS serialisieren und committen auf Feature-Branch
    const newIcs = serializeICS(events);
    await putFile(owner, repo, path, featureBranch, `Update calendar via Web-Editor (${events.length} events)`, newIcs, latest.sha);

    // 5) PR-Schritt entfällt – stattdessen Hinweis/Link zum Branch
    const branchUrl = `https://github.com/${owner}/${repo}/tree/${featureBranch}`;
    setStatus(`Gespeichert im Branch: ${featureBranch}`);
    alert(`Gespeichert im Branch:\n${featureBranch}\n\nÖffnen: ${branchUrl}\nHinweis: PRs sind in diesem Repository deaktiviert.`);
  }catch(e){
    console.error(e);
    setStatus('Fehler beim Speichern: ' + e.message);
    alert('Fehler beim Speichern: ' + e.message);
  }
}

// ===== Download Arbeitskopie =====
function downloadICS(){
  const text = serializeICS(events);
  const blob = new Blob([text], {type:'text/calendar;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'schulkalender-export.ics';
  a.click();
  URL.revokeObjectURL(url);
}

// ===== Events verbinden =====
UI.loadBtn.addEventListener('click', doLoad);
UI.saveBtn.addEventListener('click', doSave);
UI.newBtn.addEventListener('click', ()=>openModal(-1));
UI.downloadBtn.addEventListener('click', downloadICS);
UI.viewUpcoming.addEventListener('click', ()=>{ currentView='upcoming'; UI.viewUpcoming.classList.add('active'); UI.viewUpcoming.setAttribute('aria-pressed','true'); UI.viewAll.classList.remove('active'); UI.viewAll.setAttribute('aria-pressed','false'); renderList(); });
UI.viewAll.addEventListener('click', ()=>{ currentView='all'; UI.viewAll.classList.add('active'); UI.viewAll.setAttribute('aria-pressed','true'); UI.viewUpcoming.classList.remove('active'); UI.viewUpcoming.setAttribute('aria-pressed','false'); renderList(); });
UI.searchInput.addEventListener('input', renderList);
UI.setTokenBtn.addEventListener('click', ()=>{
  const t = prompt('GitHub Token eingeben (wird lokal gespeichert):', TOKEN || '');
  if (t != null){ setToken((t||'').trim()); alert('Token gespeichert.'); }
});
UI.clearTokenBtn.addEventListener('click', ()=>{ setToken(''); alert('Token gelöscht.'); });

// Modal
UI.cancelBtn.addEventListener('click', closeModal);
UI.saveEventBtn.addEventListener('click', saveEventFromForm);
UI.deleteBtn.addEventListener('click', deleteEvent);
UI.fAllDay.addEventListener('change', toggleTimeFields);

// ===== Init Defaults =====
(function initDefaults(){
  UI.owner.value = CONFIG.OWNER;
  UI.repo.value = CONFIG.REPO;
  UI.path.value = CONFIG.FILE_PATH;
  UI.baseBranch.value = CONFIG.BASE_BRANCH;
  UI.featurePrefix.value = CONFIG.FEATURE_BRANCH_PREFIX;
  setNotice('Bereit. Bitte Token setzen und „Laden“ klicken.');
  setStatus('bereit');
})();

