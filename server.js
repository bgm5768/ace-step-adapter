import http from 'node:http';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
try {
  const envText = await fs.readFile(path.join(root, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}
const publicDir = path.join(root, 'public');
const workflowPath = process.env.ACE_WORKFLOW || path.join(root, 'workflow_api.json');
const comfyUrl = (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/$/, '');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const jobs = new Map();

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 2_000_000) reject(new Error('요청이 너무 큽니다.')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON 형식이 올바르지 않습니다.')); } });
    req.on('error', reject);
  });
}

function text(value) { return value == null ? '' : String(value); }
function lower(value) { return text(value).toLowerCase(); }

// API-format workflow JSON에서 노드 제목/입력 키를 보고 값을 찾아 넣습니다.
function patchWorkflow(workflow, form) {
  const out = structuredClone(workflow);
  const groups = {
    // 'clip'은 모델 연결/모델 파일명에도 포함되므로 매핑 키로 사용하지 않습니다.
    // Ace Step 1.5의 음악 설명은 tags 입력입니다.
    clip: ['prompt', 'description', 'positive', 'text', 'caption', 'tags', 'music description'],
    lyrics: ['lyrics', 'lyric', '歌詞', 'text prompt'],
    bpm: ['bpm', 'tempo'],
    key: ['key', 'scale', 'tonality', '조성'],
    duration: ['duration', 'seconds', 'length', '음악 길이'],
    seed: ['seed', 'random_seed']
  };
  const values = { clip: form.clip, lyrics: form.lyrics, bpm: form.bpm, key: form.key, duration: form.duration, seed: form.seed };
  let changed = [];
  for (const [id, node] of Object.entries(out)) {
    const haystack = `${lower(node._meta?.title)} ${lower(node.title)} ${Object.keys(node.inputs || {}).map(lower).join(' ')}`;
    for (const [field, aliases] of Object.entries(groups)) {
      if (values[field] === undefined || values[field] === '') continue;
      const match = aliases.some(alias => haystack.includes(lower(alias)));
      if (!match) continue;
      // ComfyUI의 연결 입력(배열)은 절대 덮어쓰지 않습니다.
      const scalarKeys = Object.keys(node.inputs || {}).filter(key => {
        const value = node.inputs[key];
        return value === null || ['string', 'number', 'boolean'].includes(typeof value);
      });
      for (const key of scalarKeys) {
        const keyText = lower(key);
        if (aliases.some(alias => keyText.includes(lower(alias))) || ['text', 'value', 'prompt', 'seed'].includes(keyText)) {
          node.inputs[key] = field === 'seed' ? Number(values[field]) : values[field];
          changed.push(`${id}.${key}`);
          break;
        }
      }
    }
  }
  return { workflow: out, changed };
}

async function comfy(pathname, options = {}) {
  const response = await fetch(`${comfyUrl}${pathname}`, options);
  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch {}
    try {
      const parsed = JSON.parse(detail);
      detail = parsed.error?.message || parsed.node_errors ? JSON.stringify(parsed) : detail;
    } catch {}
    throw new Error(`ComfyUI 응답 오류 (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`);
  }
  return response;
}

async function runJob(job, form) {
  try {
    let template;
    try {
      template = JSON.parse(await fs.readFile(workflowPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Ace Step 워크플로 파일이 없습니다. ComfyUI에서 'Save (API Format)'으로 저장한 JSON을 ${workflowPath}에 복사하세요.`);
      throw new Error(`워크플로 JSON을 읽을 수 없습니다: ${error.message}`);
    }
    const patched = patchWorkflow(template, form);
    job.changed = patched.changed;
    if (!patched.changed.length) throw new Error('워크플로에서 변경할 입력을 찾지 못했습니다. workflow_api.json의 노드 제목 또는 입력 이름을 확인하세요.');
    const clientId = crypto.randomUUID();
    const response = await comfy('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: patched.workflow, client_id: clientId }) });
    const submitted = await response.json();
    job.promptId = submitted.prompt_id;
    job.status = 'running';
    for (let i = 0; i < 240; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const history = await (await comfy(`/history/${encodeURIComponent(job.promptId)}`)).json();
      const item = history[job.promptId];
      if (!item) continue;
      if (item.status?.status_str === 'error' || item.status?.status_str === 'failed') throw new Error('ComfyUI가 워크플로 실행에 실패했습니다.');
      if (item.status?.completed || item.outputs) {
        const audio = [];
        for (const node of Object.values(item.outputs || {})) {
          for (const key of ['audio', 'gifs', 'images']) for (const file of node[key] || []) if (file.filename) audio.push(file);
        }
        const chosen = audio.find(file => /\.(wav|mp3|flac|ogg|m4a)$/i.test(file.filename)) || audio[0];
        if (!chosen) throw new Error('생성은 끝났지만 오디오 결과 파일을 찾지 못했습니다. Save Audio 노드를 확인하세요.');
        job.result = chosen;
        job.status = 'done';
        return;
      }
    }
    throw new Error('생성 시간이 초과되었습니다. ComfyUI 화면에서 실행 상태를 확인하세요.');
  } catch (error) { job.status = 'error'; job.error = error.message; }
}

async function serveFile(req, res, pathname) {
  const safe = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(publicDir, safe));
  if (!file.startsWith(publicDir)) return json(res, 403, { error: 'Forbidden' });
  try {
    let data = await fs.readFile(file);
    if (path.basename(file) === 'index.html') data = Buffer.from(data.toString().replace('</body>', '<script src="history.js"></script></body>'));
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  } catch { json(res, 404, { error: 'Not found' }); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
    if (url.pathname === '/api/health') {
      try { await comfy('/system_stats'); json(res, 200, { ok: true, comfyUrl, workflow: path.basename(workflowPath), workflowExists: await fs.access(workflowPath).then(() => true).catch(() => false) }); } catch { json(res, 200, { ok: false, comfyUrl, workflow: path.basename(workflowPath), workflowExists: await fs.access(workflowPath).then(() => true).catch(() => false) }); }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      return res.end(`window.ACE_STEP_CONFIG=${JSON.stringify({ bridgeUrl: `http://127.0.0.1:${port}` })};`);
    }
    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const form = await body(req); const id = crypto.randomUUID(); const job = { id, status: 'queued', createdAt: Date.now() }; jobs.set(id, job); runJob(job, form); return json(res, 202, { id });
    }
    const statusMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && statusMatch) { const job = jobs.get(statusMatch[1]); return job ? json(res, 200, job) : json(res, 404, { error: '작업을 찾을 수 없습니다.' }); }
    const fileMatch = url.pathname.match(/^\/api\/download\/([^/]+)$/);
    if (req.method === 'GET' && fileMatch) {
      const job = jobs.get(fileMatch[1]); if (!job?.result) return json(res, 404, { error: '다운로드할 결과가 없습니다.' });
      const query = new URLSearchParams(job.result).toString(); const upstream = await comfy(`/view?${query}`); res.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg', 'Content-Disposition': `attachment; filename="${job.result.filename}"`, 'Access-Control-Allow-Origin': '*' }); return Readable.fromWeb(upstream.body).pipe(res);
    }
    return serveFile(req, res, url.pathname);
  } catch (error) { json(res, 500, { error: error.message }); }
});
server.listen(port, host, () => console.log(`Ace Step Adapter: http://${host === '0.0.0.0' ? 'PC-LAN-IP' : host}:${port}`));

