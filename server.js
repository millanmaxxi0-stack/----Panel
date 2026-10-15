'use strict';
const express = require('express'), http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { WebSocketServer } = require('ws'), multer = require('multer'), AdmZip = require('adm-zip');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const PASS = process.env.PANEL_PASSWORD || 'admin';
const MEM_LIMIT = (+process.env.MEMORY_LIMIT_MB || 512) * 1048576;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const ROOT = path.join(DATA, 'server'), NODES = path.join(DATA, 'nodes'), TMP = path.join(DATA, 'tmp'), CFG = path.join(DATA, 'config.json');
[ROOT, NODES, TMP].forEach(d => fs.mkdirSync(d, { recursive: true }));

const DEFAULT = { name: 'My Server', node: 'system', cmd: 'npm start', autoRestart: true, vars: [{ key: 'NODE_ENV', value: 'production' }] };
const loadCfg = () => { try { return { ...DEFAULT, ...JSON.parse(fs.readFileSync(CFG, 'utf8')) }; } catch { return { ...DEFAULT }; } };
const saveCfg = c => fs.writeFileSync(CFG, JSON.stringify(c, null, 2));

/* ---------- auth ---------- */
const tokens = new Set();
const auth = (req, res, next) => {
  const t = req.headers['x-token'] || req.query.token;
  if (tokens.has(t)) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

/* ---------- process manager ---------- */
let proc = null, status = 'offline', kind = null, startedAt = 0, userStop = false, crashes = [];
const logs = [], clients = new Set();
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const bcast = o => clients.forEach(ws => send(ws, o));
const setStatus = s => { status = s; bcast({ t: 'status', d: s }); };
const log = d => { logs.push(d); if (logs.length > 1500) logs.shift(); bcast({ t: 'log', d }); };
const sys = m => log(`\x1b[36m[SH4D0W] ${m}\x1b[0m\r\n`);

const nodeBin = v => (v && v !== 'system') ? path.join(NODES, 'v' + v, 'node_modules', 'node', 'bin') : null;
const buildEnv = cfg => {
  const env = { ...process.env, FORCE_COLOR: '1', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
  delete env.PANEL_PASSWORD; delete env.PORT;
  // Git dependencies (github:user/repo, git+ssh://...) normally try SSH, which has no keys here. Force HTTPS instead.
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_0: 'ssh://git@github.com/',
    GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:' });
  cfg.vars.forEach(v => { if (v.key) env[v.key] = v.value; });
  const b = nodeBin(cfg.node);
  if (b && fs.existsSync(b)) env.PATH = b + path.delimiter + env.PATH;
  return env;
};

function run(cmd, env, k, onExit) {
  proc = spawn('sh', ['-c', cmd], { cwd: ROOT, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  kind = k; startedAt = Date.now();
  proc.stdout.on('data', d => log(d.toString().replace(/\r?\n/g, '\r\n')));
  proc.stderr.on('data', d => log(d.toString().replace(/\r?\n/g, '\r\n')));
  proc.stdin.on('error', () => {});
  proc.on('error', e => log(`\x1b[31m${e.message}\x1b[0m\r\n`));
  proc.on('close', code => { proc = null; kind = null; onExit(code); });
  return proc;
}

async function ensureNode(cfg) {
  if (cfg.node === 'system') return true;
  const b = nodeBin(cfg.node);
  if (fs.existsSync(path.join(b, 'node'))) return true;
  sys(`Downloading Node.js ${cfg.node} (first time only)...`);
  const dir = path.join(NODES, 'v' + cfg.node);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"n","version":"1.0.0","private":true}');
  return new Promise(res => {
    const p = spawn('npm', ['install', 'node@' + cfg.node, '--no-audit', '--no-fund', '--no-progress', '--prefix', dir], { env: process.env });
    p.stdout.on('data', d => log(d.toString().replace(/\r?\n/g, '\r\n')));
    p.stderr.on('data', d => log(d.toString().replace(/\r?\n/g, '\r\n')));
    p.on('close', c => { const ok = c === 0 && fs.existsSync(path.join(b, 'node')); if (!ok) sys('Node download failed. Pick another version or use System default.'); res(ok); });
  });
}

async function start() {
  if (proc || status !== 'offline') return;
  userStop = false; const cfg = loadCfg();
  setStatus('starting');
  if (!(await ensureNode(cfg))) return setStatus('offline');
  const nv = cfg.node === 'system' ? process.version : 'v' + cfg.node;
  log(`\x1b[32mcontainer@shadow~ \x1b[0mnode ${nv}\r\n\x1b[32mcontainer@shadow~ \x1b[0m${cfg.cmd}\r\n`);
  run(cfg.cmd, buildEnv(cfg), 'server', code => {
    sys(`Process exited with code ${code}`); setStatus('offline');
    if (!userStop && cfg.autoRestart && code !== 0 && code !== null) {
      const now = Date.now(); crashes = crashes.filter(t => now - t < 60000); crashes.push(now);
      if (crashes.length > 5) return sys('Crash loop detected (5 crashes in 60s). Auto-restart disabled.');
      sys('Crashed. Restarting in 5s...'); setTimeout(() => status === 'offline' && !proc && !userStop && start(), 5000);
    }
  });
  setStatus('running');
}

function stop(sig) {
  if (!proc) return;
  userStop = true; setStatus('stopping');
  const pid = proc.pid;
  try { process.kill(-pid, sig || 'SIGTERM'); } catch {}
  if (sig !== 'SIGKILL') setTimeout(() => { if (proc && proc.pid === pid) try { process.kill(-pid, 'SIGKILL'); } catch {} }, 10000);
}

const INSTALL = 'npm install --no-audit --no-fund --no-progress';
async function install() {
  if (proc || status !== 'offline') return sys('Stop the server before running install.');
  const cfg = loadCfg(); setStatus('installing');
  if (!(await ensureNode(cfg))) return setStatus('offline');
  if (!fs.existsSync(path.join(ROOT, 'package.json'))) { sys('No package.json found in the file manager.'); return setStatus('offline'); }
  log(`\x1b[32mcontainer@shadow~ \x1b[0mnpm install\r\n`);
  // Stages: normal (installs peer deps) -> --force (accepts conflicts but still installs peers) -> legacy-peer-deps (last resort).
  const cmd = `(${INSTALL} || (echo '[retry] forcing install (peer dependencies are still installed)' && ${INSTALL} --force --prefer-online) || (echo '[retry] cleaning cache + legacy peer deps' && npm cache clean --force && ${INSTALL} --legacy-peer-deps --prefer-online))`;
  run(cmd, buildEnv(cfg), 'install', code => { sys(code === 0 ? 'Install finished successfully.' : `Install failed (code ${code}).`); setStatus('offline'); });
}

/* ---------- stats (reads /proc, no native deps) ---------- */
let lastCpu = null;
function stats() {
  const out = { status, cpu: 0, ram: 0, ramLimit: MEM_LIMIT, uptime: status === 'running' && kind === 'server' ? Date.now() - startedAt : 0, disk: 0 };
  if (!proc) { lastCpu = null; return out; }
  let ticks = 0, rss = 0;
  try {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const s = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
        if (+f[2] !== proc.pid) continue;
        ticks += +f[11] + +f[12];
        rss += +fs.readFileSync(`/proc/${d}/statm`, 'utf8').split(' ')[1] * 4096;
      } catch {}
    }
  } catch { rss = 0; }
  const now = Date.now();
  if (lastCpu) out.cpu = Math.min(100 * Math.ceil(os.cpus().length || 1), Math.max(0, ((ticks - lastCpu.t) / 100) / ((now - lastCpu.n) / 1000) * 100));
  lastCpu = { t: ticks, n: now }; out.ram = rss; return out;
}
function dirSize(p) { let s = 0; try { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); s += e.isDirectory() ? dirSize(f) : fs.statSync(f).size; } } catch {} return s; }
let diskCache = 0, diskAt = 0;

/* ---------- http ---------- */
const app = express(); app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_, r) => r.send('ok'));
app.post('/api/login', (req, res) => {
  const a = Buffer.from(String(req.body.password || '')), b = Buffer.from(PASS);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Invalid password' });
  const t = crypto.randomBytes(24).toString('hex'); tokens.add(t); res.json({ token: t });
});
app.use('/api', auth);

const safe = p => { const r = path.resolve(ROOT, '.' + path.sep + String(p || '')); if (r !== ROOT && !r.startsWith(ROOT + path.sep)) throw new Error('Invalid path'); return r; };
const wrap = fn => (req, res) => { try { fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); } };

/* Extract a zip; if everything sits inside one wrapper folder, flatten it so package.json lands in the root. */
function extractZip(zipFile, destDir) {
  const zip = new AdmZip(zipFile);
  const entries = zip.getEntries().filter(e => !/^__MACOSX\//.test(e.entryName) && !/(^|\/)\.DS_Store$/.test(e.entryName));
  const names = entries.map(e => e.entryName.replace(/\\/g, '/').replace(/^\/+/, ''));
  let prefix = '';
  for (let i = 0; i < 3; i++) {
    const rest = names.map(n => n.slice(prefix.length)).filter(Boolean);
    const tops = new Set(rest.map(n => n.split('/')[0]));
    if (rest.length && tops.size === 1 && rest.every(n => n.includes('/'))) prefix += [...tops][0] + '/'; else break;
  }
  entries.forEach((e, i) => {
    const rel = names[i].slice(prefix.length); if (!rel) return;
    const target = path.resolve(destDir, rel);
    if (target !== destDir && !target.startsWith(destDir + path.sep)) return; // zip-slip protection
    if (e.isDirectory) fs.mkdirSync(target, { recursive: true });
    else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, e.getData()); }
  });
  return prefix;
}

app.get('/api/config', (_, r) => r.json(loadCfg()));
app.put('/api/config', wrap((req, res) => {
  const b = req.body, c = loadCfg();
  if (b.name !== undefined) c.name = String(b.name).slice(0, 40);
  if (b.node !== undefined) c.node = b.node === 'system' ? 'system' : String(Math.min(25, Math.max(18, parseInt(b.node) || 20)));
  if (b.cmd !== undefined) c.cmd = String(b.cmd).slice(0, 500);
  if (b.autoRestart !== undefined) c.autoRestart = !!b.autoRestart;
  if (Array.isArray(b.vars)) c.vars = b.vars.filter(v => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.key || '')).map(v => ({ key: v.key, value: String(v.value ?? '') }));
  saveCfg(c); res.json(c);
}));
app.post('/api/power', wrap((req, res) => {
  const a = req.body.action;
  if (a === 'start') start(); else if (a === 'stop') stop('SIGTERM'); else if (a === 'kill') stop('SIGKILL');
  else if (a === 'restart') { if (proc) { stop('SIGTERM'); const w = setInterval(() => { if (!proc && status === 'offline') { clearInterval(w); start(); } }, 300); } else start(); }
  else if (a === 'install') install(); else throw new Error('Unknown action');
  res.json({ ok: true });
}));
app.get('/api/files', wrap((req, res) => {
  const d = safe(req.query.path);
  const list = fs.readdirSync(d, { withFileTypes: true }).map(e => { const s = fs.statSync(path.join(d, e.name)); return { name: e.name, dir: e.isDirectory(), size: s.size, mtime: s.mtimeMs }; });
  list.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name)); res.json(list);
}));
app.get('/api/file', wrap((req, res) => { const f = safe(req.query.path); if (fs.statSync(f).size > 3e6) throw new Error('File too large to edit (max 3 MB)'); res.json({ content: fs.readFileSync(f, 'utf8') }); }));
app.put('/api/file', wrap((req, res) => { const f = safe(req.body.path); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, req.body.content ?? ''); res.json({ ok: true }); }));
app.post('/api/mkdir', wrap((req, res) => { fs.mkdirSync(safe(req.body.path), { recursive: true }); res.json({ ok: true }); }));
app.post('/api/rename', wrap((req, res) => { fs.renameSync(safe(req.body.from), safe(req.body.to)); res.json({ ok: true }); }));
app.post('/api/delete', wrap((req, res) => { (req.body.paths || []).forEach(p => { const f = safe(p); if (f !== ROOT) fs.rmSync(f, { recursive: true, force: true }); }); res.json({ ok: true }); }));
app.post('/api/unzip', wrap((req, res) => { const f = safe(req.body.path); extractZip(f, path.dirname(f)); res.json({ ok: true }); }));
app.get('/api/download', wrap((req, res) => { const f = safe(req.query.path); if (fs.statSync(f).isDirectory()) throw new Error('Cannot download a folder'); res.download(f); }));

const upload = multer({ dest: TMP, limits: { fileSize: 600 * 1048576 } });
app.post('/api/upload', upload.any(), (req, res) => {
  try {
    const base = safe(req.query.path); const rels = JSON.parse(req.body.rels || '[]'); let n = 0;
    (req.files || []).forEach((f, i) => {
      const rel = (rels[i] || f.originalname).replace(/\\/g, '/').replace(/^\/+/, '');
      const dest = path.resolve(base, rel);
      if (dest !== ROOT && !dest.startsWith(ROOT + path.sep)) throw new Error('Invalid path');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (req.body.extract === '1' && /\.zip$/i.test(rel)) { extractZip(f.path, path.dirname(dest)); fs.rmSync(f.path, { force: true }); }
      else { try { fs.renameSync(f.path, dest); } catch { fs.copyFileSync(f.path, dest); fs.rmSync(f.path, { force: true }); } }
      n++;
    });
    res.json({ ok: true, count: n });
  } catch (e) { (req.files || []).forEach(f => fs.rmSync(f.path, { force: true })); res.status(400).json({ error: e.message }); }
});

/* ---------- websocket ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const t = new URL(req.url, 'http://x').searchParams.get('token');
  if (!tokens.has(t)) return ws.close(4001);
  clients.add(ws); send(ws, { t: 'history', d: logs.join('') }); send(ws, { t: 'status', d: status });
  ws.on('message', m => { try { const o = JSON.parse(m); if (o.t === 'cmd' && proc && proc.stdin.writable) proc.stdin.write(String(o.d) + '\n'); } catch {} });
  ws.on('close', () => clients.delete(ws));
});
setInterval(() => {
  if (!clients.size) return;
  if (Date.now() - diskAt > 15000) { diskCache = dirSize(ROOT); diskAt = Date.now(); }
  const s = stats(); s.disk = diskCache; bcast({ t: 'stats', d: s });
}, 2000);

process.on('uncaughtException', e => console.error(e));
process.on('SIGTERM', () => { stop('SIGKILL'); setTimeout(() => process.exit(0), 300); });
server.listen(PORT, '0.0.0.0', () => console.log(`Panel running on :${PORT} (password: ${process.env.PANEL_PASSWORD ? 'from env' : 'admin — set PANEL_PASSWORD!'})`));
