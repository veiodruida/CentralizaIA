const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { Server } = require('socket.io');
const { promisify } = require('util');
const { exec, spawn } = require('child_process');
const checkDiskSpace = require('check-disk-space').default;

// --- LOGGING SYSTEM ---
const LOG_FILE = path.join(__dirname, 'server.log');
const logClients = new Set();

const DEBUG_PAYLOAD_FILE = path.join(__dirname, 'debug_payload.log');
const logDebugPayload = (label, data) => {
    try {
        const entry = `\n[${new Date().toISOString()}] === ${label} ===\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`;
        fs.appendFileSync(DEBUG_PAYLOAD_FILE, entry);
    } catch(e) {}
};

const broadcastLog = (level, msg) => {
    const logEntry = JSON.stringify({ level, msg, time: new Date().toISOString() });
    logClients.forEach(client => {
        if (!client.writableEnded) client.write(`data: ${logEntry}\n\n`);
    });
};

const logger = {
    info: (msg) => {
        const entry = `[${new Date().toISOString()}] [INFO] ${msg}`;
        console.log(entry);
        fs.appendFileSync(LOG_FILE, entry + '\n');
        broadcastLog('INFO', msg);
    },
    error: (msg, err) => {
        const entry = `[${new Date().toISOString()}] [ERROR] ${msg} ${err ? (err.message || err) : ''}`;
        console.error(entry);
        fs.appendFileSync(LOG_FILE, entry + '\n');
        broadcastLog('ERROR', `${msg} ${err ? (err.message || err) : ''}`);
    },
    warn: (msg) => {
        const entry = `[${new Date().toISOString()}] [WARN] ${msg}`;
        console.warn(entry);
        fs.appendFileSync(LOG_FILE, entry + '\n');
        broadcastLog('WARN', msg);
    }
};

process.on('uncaughtException', (err) => {
    logger.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('UNHANDLED REJECTION:', reason);
});

// --- CACHING SYSTEM ---
const cache = {
    store: new Map(),
    get: (key) => {
        const item = cache.store.get(key);
        if (!item) return null;
        if (Date.now() > item.expiry) {
            cache.store.delete(key);
            return null;
        }
        return item.data;
    },
    set: (key, data, ttlMs = 10000) => {
        cache.store.set(key, { data, expiry: Date.now() + ttlMs });
    },
    clear: () => cache.store.clear()
};

async function getOllamaMap() {
    const blobToName = {};
    const manifestDir = path.join(os.homedir(), '.ollama', 'models', 'manifests');
    
    try {
        if (!fs.existsSync(manifestDir)) return blobToName;

        function scanManifestDir(currentDir, repoParts = []) {
            if (!fs.existsSync(currentDir)) return;
            const entries = fs.readdirSync(currentDir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    scanManifestDir(fullPath, [...repoParts, entry.name]);
                } else if (entry.isFile()) {
                    let nameParts = [...repoParts];
                    if (nameParts[0] === 'registry.ollama.ai') nameParts = nameParts.slice(1);
                    if (nameParts[0] === 'library') nameParts = nameParts.slice(1);
                    const modelName = nameParts.join('/') + ':' + entry.name;
                    
                    try {
                        const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                        if (content.layers) {
                            for (const layer of content.layers) {
                                if (layer.digest && layer.digest.startsWith('sha256:')) {
                                    const blobName = layer.digest.replace('sha256:', 'sha256-');
                                    blobToName[blobName] = modelName;
                                }
                            }
                        }
                    } catch (e) {}
                }
            }
        }
        
        scanManifestDir(manifestDir);
        logger.info(`[Ollama] Mapped ${Object.keys(blobToName).length} models from manifests.`);
    } catch (e) {
        logger.error(`[Ollama] Failed to scan manifests`, e);
    }
    return blobToName;
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Performance Middleware: Logging
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        if (req.path.startsWith('/api') || req.path.startsWith('/v1')) {
            logger.info(`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
        }
    });
    next();
});

app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    
    logClients.add(res);
    req.on('close', () => logClients.delete(res));
});

const CONFIG_FILE = path.join(__dirname, 'config.json');
const DEFAULT_CENTRAL_DIR = 'C:\\AI_Models';
let config = {
    centralDir: DEFAULT_CENTRAL_DIR,
    scanDirectories: [
        path.join(os.homedir(), '.cache', 'lm-studio', 'models'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'StabilityMatrix', 'Models'),
        path.join(os.homedir(), '.ollama', 'models', 'blobs'),
        path.join(os.homedir(), 'ComfyUI', 'models', 'checkpoints'),
        path.join(os.homedir(), 'llama.cpp', 'models'),
        path.join(os.homedir(), '.cache', 'huggingface', 'hub'),
    ],
    comfyDir: 'C:\\ComfyUI_windows_portable',
    sectionOrder: ['Ollama', 'ComfyUI', 'LM Studio / Hugging Face', 'Standalone'],
    activeRouterModel: null,
    vramShieldLimit: 32768
};
if (fs.existsSync(CONFIG_FILE)) {
    try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch (e) { logger.error('Failed to read config', e); }
}
if (!fs.existsSync(config.centralDir)) fs.mkdirSync(config.centralDir, { recursive: true });
function saveConfig() { 
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); 
    cache.clear(); // Clear cache when config changes
}

const MODEL_EXTENSIONS = ['.gguf', '.safetensors', '.ckpt', '.bin', '.pt', '.pth'];

async function scanDirectory(dir, modelsList, ollamaMap) {
    if (!fs.existsSync(dir)) return;
    const normalizedDir = dir.toLowerCase().replace(/\\/g, '/');
    const normalizedCentralDir = config.centralDir.toLowerCase().replace(/\\/g, '/');
    let source = 'Local';
    if (normalizedDir.includes('.ollama')) source = 'Ollama';
    else if (normalizedDir.includes('comfyui')) source = 'ComfyUI';
    // LM Studio and Hugging Face both run via llama.cpp — group them together
    else if (normalizedDir.includes('lm-studio') || normalizedDir.includes('.lmstudio') || normalizedDir.includes('huggingface') || normalizedDir.includes('llama.cpp')) source = 'LM Studio / Hugging Face';
    else if (normalizedDir.includes('stabilitymatrix')) source = 'Stability Matrix';
    // Standalone: files stored directly under the central AI_Models directory
    // (but NOT inside the Centraliza.ai hardlink subfolder — those are duplicates)
    else if (normalizedDir.startsWith(normalizedCentralDir)) source = 'Standalone';

    // Skip the Centraliza.ai hardlink folder — its contents will appear via
    // the original provider directory (same inode). Orphaned files that have
    // no counterpart outside will be caught by the inode-based dedup below.
    // REMOVED: we now scan Centraliza.ai and deduplicate by inode at the API level.

    try {
        const entries = await promisify(fs.readdir)(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) await scanDirectory(fullPath, modelsList, ollamaMap);
            else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                const isOllamaBlob = entry.name.startsWith('sha256-') && ext === '';
                // Skip partial files/blobs: Ollama appends '-partial' or '.partial'
                const isPartial = entry.name.endsWith('-partial') || entry.name.endsWith('.partial') || entry.name.endsWith('.part');
                
                if (isPartial) continue;

                if (MODEL_EXTENSIONS.includes(ext) || isOllamaBlob) {
                    try {
                        let finalModelName = entry.name;
                        let displayModelName = entry.name;
                        let ollamaTag = null;
                        let repoId = null;
                        
                        if (isOllamaBlob) {
                            const humanName = ollamaMap[entry.name];
                            if (humanName) {
                                ollamaTag = humanName;
                                finalModelName = humanName.replace(/[:\/]/g, '-') + '.gguf';
                                displayModelName = humanName;
                            } else {
                                // Skip unmapped blobs (partial or orphans)
                                continue;
                            }
                        }
                        
                        if (fullPath.includes('models--')) {
                            const parts = fullPath.split('models--');
                            if (parts.length > 1) {
                                const repoParts = parts[1].split(path.sep)[0].split('--');
                                if (repoParts.length >= 2) repoId = `${repoParts[0]}/${repoParts.slice(1).join('-')}`;
                            }
                        }
                        
                        const modelBaseName = path.parse(finalModelName).name;
                        const expectedDestPath = path.resolve(config.centralDir, 'Centraliza.ai', modelBaseName, finalModelName);
                        let isCentralized = false;
                        
                        try {
                            if (fs.existsSync(expectedDestPath)) {
                                const actualStat = await promisify(fs.stat)(fullPath);
                                const destStat = await promisify(fs.stat)(expectedDestPath);
                                if (actualStat.ino === destStat.ino || (actualStat.size === destStat.size && Math.abs(actualStat.mtime - destStat.mtime) < 1000)) {
                                    isCentralized = true;
                                }
                            }
                        } catch (e) {}

                        const actualStat = await promisify(fs.stat)(fullPath);
                        if (actualStat.size > 1024 * 1024) {
                            modelsList.push({
                                name: displayModelName,
                                path: fullPath,
                                size: actualStat.size,
                                inode: actualStat.ino,   // used for hardlink dedup
                                isSymlink: isCentralized,
                                targetPath: isCentralized ? expectedDestPath : null,
                                centralPath: expectedDestPath,
                                finalModelName: finalModelName,
                                source: source,
                                ollamaTag: ollamaTag,
                                repoId: repoId,
                                extension: ext || '.gguf'
                            });
                        }
                    } catch (err) {}
                }
            }
        }
    } catch (e) {}
}

app.get('/api/config', (req, res) => res.json(config));
app.post('/api/config', (req, res) => {
    Object.assign(config, req.body);
    saveConfig();
    res.json({ success: true, config });
});

app.post('/api/active-model', (req, res) => {
    const { model } = req.body;
    config.activeRouterModel = model;
    saveConfig();
    res.json({ success: true, activeModel: model });
});
app.get('/api/active-model', (req, res) => {
    res.json({ activeModel: config.activeRouterModel });
});

app.post('/api/auto-detect', (req, res) => {
    const common = [
        path.join(os.homedir(), '.cache', 'lm-studio', 'models'),
        path.join(os.homedir(), 'ComfyUI', 'models'),
        path.join(os.homedir(), 'llama.cpp', 'models'),
        path.join(os.homedir(), '.ollama', 'models'),
        path.join(os.homedir(), '.cache', 'huggingface', 'hub')
    ];
    
    // Add common portable roots
    ['C', 'D', 'E', 'F'].forEach(drive => {
        const p = `${drive}:\\ComfyUI_windows_portable`;
        if (fs.existsSync(p)) common.push(p);
    });

    let added = 0;
    common.forEach(p => { 
        if (fs.existsSync(p)) {
            // Search for ComfyUI root by climbing up
            let current = p;
            for (let i = 0; i < 4; i++) {
                if (fs.existsSync(path.join(current, 'run_nvidia_gpu.bat')) || fs.existsSync(path.join(current, 'main.py'))) {
                    config.comfyDir = current;
                    break;
                }
                current = path.dirname(current);
            }

            if (!config.scanDirectories.includes(p)) { 
                config.scanDirectories.push(p); 
                added++; 
            } 
        }
    });
    if (added > 0) saveConfig();
    res.json({ success: true, added, config });
});

app.get('/api/pick-folder', (req, res) => {
    const platform = os.platform();
    const initialPath = req.query.initialPath || '';
    let command = '';

    if (platform === 'win32') {
        const psFile = path.join(__dirname, 'picker.ps1');
        command = `powershell -NoProfile -ExecutionPolicy Bypass -sta -File "${psFile}" -initialPath "${initialPath}"`;
    } else if (platform === 'darwin') {
        const startPath = initialPath ? `default location "${initialPath.replace(/\\/g, '/')}"` : '';
        command = `osascript -e 'tell application "System Events" to activate' -e 'set theFolder to choose folder with prompt "Select a folder for Centraliza.ai" ${startPath}' -e 'POSIX path of theFolder'`;
    } else {
        const startPath = initialPath ? `--filename="${initialPath}/"` : '';
        command = `zenity --file-selection --directory --title="Select a folder for Centraliza.ai" ${startPath}`;
    }
    
    exec(command, (err, stdout) => {
        if (err) return res.json({ path: null });
        const pickedPath = stdout.trim().split('\n').pop()?.trim();
        res.json({ path: pickedPath || null });
    });
});

app.get('/api/registry', (req, res) => {
    const cached = cache.get('registry');
    if (cached) return res.json(cached);

    const registryPath = path.join(__dirname, 'data', 'hf_models.json');
    if (fs.existsSync(registryPath)) {
        let registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        registry.unshift({ name: "deepseek-ai/DeepSeek-R1-Distill-Llama-8B", provider: "DeepSeek", parameter_count: "8B", min_vram_gb: 5.5, use_case: "Reasoning, Coding", pipeline_tag: "text-generation", hf_downloads: 15000000 });
        cache.set('registry', registry, 60000 * 30); // 30 min cache
        res.json(registry);
    } else res.status(404).json({ error: 'Registry not found' });
});

app.get('/api/search/hf', async (req, res) => {
    const { q, limit = 20 } = req.query;
    if (!q || String(q).trim().length < 2) return res.json([]);

    const cacheKey = `hf-search-${q}-${limit}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    try {
        const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
        const url = `https://huggingface.co/api/models?search=${encodeURIComponent(q)}&sort=downloads&direction=-1&limit=${limit}&full=false`;
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const data = await r.json();
        const normalized = (Array.isArray(data) ? data : []).map(m => ({
            id: m.id || m.modelId || '',
            name: m.id || m.modelId || '',
            provider: (m.id || m.modelId || '').split('/')[0],
            pipeline_tag: m.pipeline_tag || 'text-generation',
            hf_downloads: m.downloads || 0,
            hf_likes: m.likes || 0,
            has_gguf: (m.tags || []).includes('gguf'),
            updated_at: m.lastModified || null
        }));
        cache.set(cacheKey, normalized, 60000 * 5);
        res.json(normalized);
    } catch (err) {
        logger.error('[HF Search] Failed:', err.message);
        res.json([]);
    }
});

app.get('/api/model-readme', async (req, res) => {
    const { repoId, localPath } = req.query;
    const cacheKey = `readme-${repoId || localPath}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.send(cached);

    if (repoId) {
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        try {
            const response = await fetch(`https://huggingface.co/api/models/${repoId}/readme`);
            const data = await response.text();
            cache.set(cacheKey, data, 60000 * 60); // 1h cache
            return res.send(data);
        } catch (e) { logger.error('Failed to fetch HF readme', e); }
    }
    if (localPath) {
        const dir = path.dirname(localPath);
        const readmeFiles = ['README.md', 'readme.md', 'model_details.json'];
        for (const f of readmeFiles) {
            const p = path.join(dir, f);
            if (fs.existsSync(p)) {
                const data = fs.readFileSync(p, 'utf8');
                cache.set(cacheKey, data, 60000 * 5); // 5 min cache
                return res.send(data);
            }
        }
    }
    res.send("No detailed description found for this model.");
});

app.get('/api/system-info', async (req, res) => {
    const cached = cache.get('system-info');
    if (cached) return res.json(cached);

    const getVram = () => new Promise((resolve) => {
        exec('nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits', (err, stdout) => {
            if (!err && stdout) {
                const parts = stdout.trim().split(',');
                return resolve({ ram: parseInt(parts[0]) * 1024 * 1024, name: parts[1]?.trim() });
            }
            exec(`powershell -command "Get-CimInstance Win32_VideoController | Select-Object Name, @{Name='VRAM';Expression={[math]::Round($_.AdapterRAM / 1)}} | ForEach-Object { $_.Name + '|' + $_.VRAM }"`, (err2, stdout2) => {
                let best = { ram: 0, name: 'Unknown' };
                if (!err2) {
                    stdout2.trim().split('\n').forEach(l => {
                        const [n, r] = l.trim().split('|');
                        const ram = Math.abs(parseFloat(r));
                        if (ram > best.ram) best = { ram, name: n };
                    });
                }
                resolve(best);
            });
        });
    });
    const v = await getVram();
    const info = { totalRam: os.totalmem(), freeRam: os.freemem(), vram: v.ram, gpuName: v.name, cpuModel: os.cpus()[0].model };
    cache.set('system-info', info, 5000); // 5s cache
    res.json(info);
});

app.get('/api/models', async (req, res) => {
    const { filter } = req.query;
    let deduped = cache.get('models-list');

    if (!deduped) {
        const modelsList = [];
        const ollamaMap = await getOllamaMap();
        for (const dir of config.scanDirectories) if (fs.existsSync(dir)) await scanDirectory(dir, modelsList, ollamaMap);

        const seenOllamaTags = new Set();
        const seenInodes = new Set();   // deduplicate hardlinks by inode
        const seenPaths = new Set();
        deduped = [];
        for (const m of modelsList) {
            if (m.ollamaTag) {
                if (seenOllamaTags.has(m.ollamaTag)) continue;
                seenOllamaTags.add(m.ollamaTag);
            } else {
                if (seenPaths.has(m.path)) continue;
                seenPaths.add(m.path);
                // If inode already seen, this is a hardlink duplicate — prefer the
                // entry from the provider directory (scanned first), skip this one.
                if (m.inode && seenInodes.has(m.inode)) continue;
                if (m.inode) seenInodes.add(m.inode);
            }

            // --- Auto-Classificação de Capacidades ---
            const nameForCheck = (m.ollamaTag || m.name || '').toLowerCase();
            
            // Excluir modelos de raciocínio puro (DeepSeek-R1) que não suportam tools
            const isReasoner = nameForCheck.includes('-r1') || nameForCheck.includes('deepseek-r1') || nameForCheck.includes('reasoning');

            // Heurística aprimorada para focar APENAS em modelos com capacidade de Tool Calling/Agentes
            const isCapableCoder = (nameForCheck.includes('coder') || 
                                   (nameForCheck.includes('deepseek') && !isReasoner) || 
                                   nameForCheck.includes('qwen') || 
                                   nameForCheck.includes('llama-3') || 
                                   nameForCheck.includes('phind') ||
                                   nameForCheck.includes('mistral') ||
                                   nameForCheck.includes('mixtral')) && !isReasoner;

            m.isCoder = isCapableCoder && m.source !== 'ComfyUI' && 
                        !nameForCheck.includes('embed') &&
                        !nameForCheck.includes('tts') &&
                        !nameForCheck.includes('whisper') &&
                        !nameForCheck.includes('sdxl') &&
                        !nameForCheck.includes('flux');

            // Modelos Multimodais (Visão)
            m.hasVision = nameForCheck.includes('vision') || nameForCheck.includes('llava') || 
                          nameForCheck.includes('pixtral') || nameForCheck.includes('minicpm-v') ||
                          nameForCheck.includes('vl');

            deduped.push(m);
        }
        cache.set('models-list', deduped, 10000); // 10s cache
    }

    if (filter === 'coder') return res.json(deduped.filter(m => m.isCoder));

    res.json(deduped);
});

app.post('/api/centralize', async (req, res) => {
    const { modelPath, finalModelName } = req.body;
    if (!modelPath || !finalModelName) return res.status(400).json({ error: 'Missing parameters' });
    
    logger.info(`[Centralize] Request for ${finalModelName} from ${modelPath}`);
    if (!fs.existsSync(modelPath)) return res.status(404).json({ error: 'Source file not found' });

    const safeName = finalModelName.trim().replace(/[:\/]/g, '-');
    const modelBaseName = path.parse(safeName).name;
    const modelDir = path.resolve(config.centralDir, 'Centraliza.ai', modelBaseName);
    const destPath = path.resolve(modelDir, safeName);
    
    if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true });
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);

    try { 
        await promisify(fs.link)(modelPath, destPath); 
        logger.info('[Centralize] Hardlink SUCCESS');
        cache.clear();
        res.json({ success: true }); 
    } catch (e) { 
        logger.warn(`Hardlink failed: ${e.message}. Attempting symlink fallback...`);
        try { 
            await promisify(fs.symlink)(modelPath, destPath, 'file'); 
            cache.clear();
            res.json({ success: true }); 
        } catch (err) { 
            logger.error(`ALL ATTEMPTS FAILED`, err);
            res.status(500).json({ error: err.message }); 
        } 
    }
});

// --- MIDDLEWARE TOOLS (WEB SEARCH) ---
async function performWebSearch(query) {
    try {
        logger.info(`[Web Search] Buscando na web por: "${query}"`);
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 segundos de limite
        
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            },
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        const text = await res.text();
        const snippets = [];
        const regex = /<a class="result__snippet[^>]*>(.*?)<\/a>/gi;
        let match;
        while ((match = regex.exec(text)) !== null && snippets.length < 5) {
            snippets.push(match[1].replace(/<\/?[^>]+(>|$)/g, "").trim());
        }
        if (snippets.length === 0) {
             if (text.toLowerCase().includes('robot') || text.toLowerCase().includes('captcha')) {
                 return "A busca falhou pois o motor de busca bloqueou o pedido (Anti-Bot/Captcha). Diga ao utilizador que não conseguiu pesquisar na internet.";
             }
             return "Nenhum resultado de busca encontrado para esta query.";
        }
        return snippets.map((s, i) => `[Resultado ${i+1}]: ${s}`).join("\n\n");
    } catch (e) {
        logger.error('[Web Search] Falha', e);
        if (e.name === 'AbortError') return "A busca falhou por Timeout (demorou mais de 15 segundos). Diga ao utilizador que o serviço de pesquisa está temporariamente indisponível.";
        return "Erro ao realizar a busca na internet: " + e.message;
    }
}

const WEB_SEARCH_TOOL = { type: 'function', function: { name: 'centraliza_web_search', description: 'Pesquisa informações atuais na internet (DuckDuckGo). Use para fatos recentes, notícias ou documentações.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Termo de busca exato' } }, required: ['query'] } } };

// --- API GATEWAY: OPENAI COMPATIBLE ---
// Allows Centraliza.ai to act as a drop-in replacement for OpenAI API clients (like Continue.dev, AutoGen, etc)
app.post('/v1/chat/completions', async (req, res) => {
    logDebugPayload('INCOMING REQUEST', { url: req.originalUrl, body: req.body });
    const { model, messages, stream = false, endpoint } = req.body;

    if (!model || !messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Invalid payload. Model and messages array are required.' });
    }

    let targetModel = model;
    if (model === 'centraliza-router') {
        if (!config.activeRouterModel) {
            return res.status(400).json({ error: 'Centraliza.AI: Nenhum modelo foi selecionado para o roteador. Por favor, abra o Dashboard e selecione um modelo na aba "Coder".' });
        }
        targetModel = config.activeRouterModel;
    }

    // Default to Ollama's Native OpenAI compatible endpoint instead of legacy /api/chat
    let targetEndpoint = endpoint;
    if (!targetEndpoint || targetEndpoint === 'http://127.0.0.1:11434/api/chat' || targetEndpoint === 'http://127.0.0.1:11434/api/generate') {
        targetEndpoint = 'http://127.0.0.1:11434/v1/chat/completions';
    }

    if (activeLlamaProcess && targetModel === currentLlamaModel) {
        targetEndpoint = `http://127.0.0.1:${currentLlamaPort}/v1/chat/completions`;
    } else if (targetModel.includes(path.sep) || targetModel.includes('/') || targetModel.toLowerCase().endsWith('.gguf')) {
        return res.status(400).json({ 
            error: `Centraliza.AI: O motor de IA não está a correr para este modelo local.\nPor favor, inicie o motor usando o botão "Iniciar Motor" na aba do Centraliza Coder.` 
        });
    }

    const finalMessages = [...messages];

    // Qwen3 thinking is controlled via the Jinja template kwarg `enable_thinking`, NOT via
    // text tokens in the system/user message. The kwarg is injected per-request below (see
    // chat_template_kwargs) and at server startup (--reasoning off). No text injection needed.

    // --- RAG RETRIEVAL INJECTION ---
    // If documents are loaded in memory, inject their full content as context.
    if (globalDocuments.length > 0) {
        logger.info(`[RAG] Found ${globalDocuments.length} documents in memory. Injecting all content as context.`);
        
        // Concatenate all chunks from all documents into a single string, identifying each file
        const allContent = globalDocuments.map(doc => `--- CONTEÚDO DO FICHEIRO: ${doc.filename} ---\n\n${doc.chunks.join('\n\n')}`).join('\n\n---\n\n');
    
        const contextStr = `O utilizador anexou ${globalDocuments.length} documento(s). O conteúdo completo está abaixo. Use esta informação como a fonte primária e única de verdade para responder ao pedido do utilizador.\n\n[CONTEXTO DOS DOCUMENTOS ANEXADOS]:\n"""\n${allContent}\n"""\n\nBaseado estritamente no contexto acima, responda ao pedido do utilizador.`;
    
        // Inject the context into the system prompt or create a new one.
        let systemMessage = finalMessages.find(m => m.role === 'system');
        if (systemMessage) {
            systemMessage.content = contextStr + '\n\n' + systemMessage.content;
        } else {
            finalMessages.unshift({ role: 'system', content: contextStr });
        }
    }

    // --- VRAM SHIELD v2: SMART COMPACTION WITH INTELLIGENT SUMMARIZATION ---
    // Protege a placa de vídeo com compaction inteligente e monitoramento de métricas
    
    // CORREÇÃO CRÍTICA DO ESTOURO DE CONTEXTO:
    // Agentes (como Claude Code/Roo) enviam max_tokens gigantes (ex: 64000) esperando modelos na nuvem.
    // O Gateway deve limitar-se SEMPRE ao teto físico real (vramShieldLimit) para proteger o motor.
    const hardwareLimit = config.vramShieldLimit || 32768;
    let realCtxLimit = hardwareLimit;
    // Se for o motor nativo Llama.cpp a correr, alinhamos estritamente ao contexto alocado no boot (Evita Crashes)
    if (activeLlamaProcess && targetModel === currentLlamaModel) {
        realCtxLimit = Math.min(hardwareLimit, currentLlamaCtx);
    }
    const requestCtx = req.body.num_ctx ? Math.min(req.body.num_ctx, realCtxLimit) : realCtxLimit;

    // Código e JSON tokenizam mais denso (~2.5 chars/token vs 3.5 para texto).
    // Margem de 75% para deixar espaço para resposta do modelo.
    const SAFE_TOKEN_LIMIT = Math.floor(requestCtx * 0.75);

    // Roo Code sends 20+ tool definitions with full schemas — this can be 30-50k chars.
    // Reserve those tokens so the message compaction budget is accurate.
    const incomingToolsChars = JSON.stringify(req.body.tools || []).length;
    const incomingToolsTokens = Math.ceil(incomingToolsChars / 2.5);
    const effectiveTokenLimit = Math.max(2000, SAFE_TOKEN_LIMIT - incomingToolsTokens);
    const CHAR_LIMIT = Math.floor(effectiveTokenLimit * 2.5);

    // Nenhuma leitura de arquivo individual deve ocupar mais de 50% do payload
    const INDIVIDUAL_MSG_LIMIT = Math.floor(CHAR_LIMIT * 0.50);

    // --- METRICS: Track compaction effectiveness ---
    let totalMessagesBefore = finalMessages.length;
    let totalCharsBefore = 0;
    let truncatedMessages = 0;
    let droppedMessages = 0;
    
    // Helper: Summarize large content intelligently
    const summarizeContent = (content, maxLen) => {
        if (typeof content !== 'string') return content;
        if (content.length <= maxLen) return content;
        
        // Smart truncation: keep beginning and end, summarize middle
        const keepStart = Math.floor(maxLen * 0.4);
        const keepEnd = Math.floor(maxLen * 0.4);
        const summaryLen = maxLen - keepStart - keepEnd;
        
        // Find a good truncation point (avoid cutting mid-line)
        const startCut = content.substring(0, keepStart);
        const endCut = content.substring(content.length - keepEnd);
        
        // Create a summary of the middle section
        const middleSummary = `\n\n... [CONTENT SUMMARY: ${(content.length / 1000).toFixed(1)}KB omitted. Key sections preserved.] ...\n\n`;
        
        return startCut + middleSummary + endCut;
    };

    // 1. Trunca respostas individuais gigantes com sumarização inteligente
    finalMessages.forEach(msg => {
        if (typeof msg.content === 'string' && msg.content.length > INDIVIDUAL_MSG_LIMIT && msg.role !== 'system') {
            truncatedMessages++;
            logger.warn(`[VRAM SHIELD] Mensagem gigante de ${msg.content.length} chars detectada no papel '${msg.role}'. Aplicando sumarização inteligente.`);
            msg.content = summarizeContent(msg.content, INDIVIDUAL_MSG_LIMIT);
        } else if (Array.isArray(msg.content)) {
            // Caso o payload venha num array (ex: multimodal)
            msg.content.forEach(item => {
                if (item.type === 'text' && item.text && item.text.length > INDIVIDUAL_MSG_LIMIT) {
                    truncatedMessages++;
                    logger.warn(`[VRAM SHIELD] Conteúdo multimodal gigante detectado. Aplicando sumarização.`);
                    item.text = summarizeContent(item.text, INDIVIDUAL_MSG_LIMIT);
                }
            });
        }
    });

    // 2. Sliding Window com compaction inteligente e métricas
    let currentChars = 0;
    const systemMsgs = finalMessages.filter(m => m.role === 'system');
    const nonSystemMsgs = finalMessages.filter(m => m.role !== 'system');
    
    systemMsgs.forEach(m => currentChars += (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length));
    
    const compactedMessages = [];
    let lastTruncatedMsg = null;
    
    // Adicionamos as mensagens de trás para frente (garantindo que o agente se lembre da ação mais recente)
    for (let i = nonSystemMsgs.length - 1; i >= 0; i--) {
        const msg = nonSystemMsgs[i];
        const msgLen = (typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content ?? null).length)
                     + (msg.tool_calls ? JSON.stringify(msg.tool_calls).length : 0);
        
        if (currentChars + msgLen > CHAR_LIMIT) {
            // Correção da Falha da Última Mensagem:
            // Se o histórico de mensagens antigas for removido, mas a ÚLTIMA AÇÃO do agente SOZINHA
            // for maior que a margem, nós a cortamos à força (em vez de descartá-la inteira).
            if (compactedMessages.length === 0) {
                 logger.warn(`[VRAM SHIELD] Apenas a última mensagem já excede a VRAM restante. Truncando agressivamente.`);
                 const allowedLen = Math.max(4000, CHAR_LIMIT - currentChars - 500); // Garante 4000 chars mínimos
                 if (typeof msg.content === 'string') {
                     msg.content = msg.content.substring(0, allowedLen) + "\n\n... [SYSTEM WARNING: EXTREME TRUNCATION APPLIED. YOUR LAST TOOL OUTPUT WAS IMMENSE.]";
                 } else if (Array.isArray(msg.content)) {
                     const textItem = msg.content.find(x => x.type === 'text');
                     if (textItem && textItem.text) {
                         textItem.text = textItem.text.substring(0, allowedLen) + "\n\n... [SYSTEM WARNING: EXTREME TRUNCATION APPLIED.]";
                     }
                 }
                 compactedMessages.unshift(msg);
            } else {
                 droppedMessages += nonSystemMsgs.length - i;
                 logger.warn(`[VRAM SHIELD] Histórico antigo do agente descartado: ${droppedMessages} mensagens removidas.`);
            }
            break; // Atingiu o teto
        }
        currentChars += msgLen;
        compactedMessages.unshift(msg);
    }
    
    // Log compaction metrics
    const totalCharsAfter = compactedMessages.reduce((sum, msg) =>
        sum + (typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length), 0
    );
    const reductionPercent = ((totalCharsBefore - totalCharsAfter) / totalCharsBefore * 100).toFixed(1);
    
    logger.info(`[VRAM SHIELD] Compaction summary: ${totalMessagesBefore} → ${compactedMessages.length} msgs, ${truncatedMessages} truncated, ${droppedMessages} dropped, ${reductionPercent}% reduction`);
    
    // Reescreve a payload da requisição com as mensagens compactadas
    finalMessages.length = 0;
    finalMessages.push(...systemMsgs, ...compactedMessages);
    // --- END VRAM SHIELD v2 ---

    // Preserve all original OpenAI properties (tools, temperature, etc) but replace model and messages
    const finalPayload = {
        ...req.body,
        model: targetModel,
        messages: finalMessages
    };
    
    // Se o cliente (ex: Roo Code) já fornecer as suas próprias tools, NÃO INJETAMOS o web search.
    // Isso previne confusão no Agente Autónomo e protege a fluidez do Streaming (SSE).
    if (!finalPayload.tools || finalPayload.tools.length === 0) {
        finalPayload.tools = [WEB_SEARCH_TOOL];
    }

    delete finalPayload.endpoint; // Remove internal routing param

    // Disable Qwen3-family thinking via Jinja template kwarg.
    // The model's chat template checks `enable_thinking` (not text tokens in messages).
    // This generates <think>\n\n</think>\n\n (empty think block) instead of <think>\n (real thinking).
    if (targetEndpoint.includes(`${currentLlamaPort}`)) {
        finalPayload.chat_template_kwargs = { enable_thinking: false };
    }

    // Cap max_tokens so estimated_prompt_tokens + max_tokens <= realCtxLimit
    {
        const estimatedPromptTokens = Math.ceil(
            (finalPayload.messages.reduce((acc, m) => {
                const contentLen = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? null).length;
                const toolCallsLen = m.tool_calls ? JSON.stringify(m.tool_calls).length : 0;
                return acc + contentLen + toolCallsLen;
            }, 0) + JSON.stringify(finalPayload.tools || []).length) / 2.5
        );
        const maxAllowedOutput = Math.max(512, realCtxLimit - estimatedPromptTokens - 200);
        if (finalPayload.max_tokens && finalPayload.max_tokens > maxAllowedOutput) {
            logger.warn(`[API Gateway] max_tokens capped ${finalPayload.max_tokens} → ${maxAllowedOutput} (prompt est. ${estimatedPromptTokens} tokens).`);
            finalPayload.max_tokens = maxAllowedOutput;
        }
    }

    logger.info(`[API Gateway] Transparent routing to ${targetEndpoint} for model: ${targetModel} (Stream: ${stream})`);
    logDebugPayload('OUTGOING PAYLOAD TO ENGINE', { endpoint: targetEndpoint, payload: finalPayload });

    try {
        let response;
        let retryCount = 0;
        const controller = new AbortController();

        res.on('close', () => {
             if (!res.writableEnded) {
                 logger.info('[API Gateway] Client disconnected prematurely, aborting upstream request.');
                 controller.abort();
             }
        });

        let maxIterations = 3;
        let currentIteration = 0;
        let streamFinished = false;

        // Moved outside the loop to persist across agent iterations
        let headersSentToClient = false;
        const sendHeaders = () => {
            if (!res.headersSent && !headersSentToClient) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders(); // Evita que o NodeJS bloqueie os headers no buffer
                headersSentToClient = true;
            }
        };

        logger.info(`[API Gateway] [AUDIT] Iniciando fluxo de geração. Prevenção de loop ativada: Máximo de ${maxIterations} iterações.`);

        while (currentIteration < maxIterations && !streamFinished) {
            currentIteration++;
            logger.info(`[API Gateway] [AUDIT] Iteração ${currentIteration}/${maxIterations} em andamento.`);
            
            while (retryCount < 5) {
                try {
                    response = await fetch(targetEndpoint, {
                        method: 'POST',
                        body: JSON.stringify(finalPayload),
                        headers: { 'Content-Type': 'application/json' },
                        signal: controller.signal
                    });
                } catch (fetchErr) {
                    logDebugPayload('FETCH ERROR', { attempt: retryCount+1, error: fetchErr.message });
                    if (fetchErr.name === 'AbortError') {
                        logger.info('[API Gateway] Upstream request aborted successfully.');
                        if (!res.headersSent) res.end();
                        return;
                    }
                    logger.warn(`[API Gateway] Falha ao conectar com motor (${retryCount+1}/5): ${fetchErr.message}`);
                    await new Promise(r => setTimeout(r, 2000));
                    retryCount++;
                    continue;
                }

                if (!response.ok) {
                    if (response.status === 503) {
                        logger.info(`[API Gateway] 503 Received. Engine might still be loading or warming up. Retrying... (${retryCount+1}/5)`);
                        await new Promise(r => setTimeout(r, 2000));
                        retryCount++;
                        continue;
                    }
                    const errText = await response.text();
                    
                    // Fallback: Modelos podem rejeitar tools retornando diversos erros (invalid_request, not supported)
                    if (response.status === 400 && (errText.toLowerCase().includes('tool') || errText.toLowerCase().includes('function') || errText.toLowerCase().includes('invalid'))) {
                        // Context overflow: emergency recompact and retry instead of failing
                        if (errText.toLowerCase().includes('context') || errText.toLowerCase().includes('exceed')) {
                            let errObj = {};
                            try { errObj = JSON.parse(errText); } catch(e) {}
                            const errDetails = errObj?.error || {};
                            const nPrompt = errDetails.n_prompt_tokens || 0;
                            const nCtx = errDetails.n_ctx || realCtxLimit;

                            if (retryCount < 3) {
                                const targetChars = Math.floor((nCtx * 0.70) * 2.5);
                                const sMsgs = finalPayload.messages.filter(m => m.role === 'system');
                                const nsMsgs = finalPayload.messages.filter(m => m.role !== 'system');
                                let chars = sMsgs.reduce((a, m) => a + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
                                const kept = [];
                                for (let i = nsMsgs.length - 1; i >= 0; i--) {
                                    const l = typeof nsMsgs[i].content === 'string' ? nsMsgs[i].content.length : JSON.stringify(nsMsgs[i].content).length;
                                    if (chars + l > targetChars) break;
                                    chars += l;
                                    kept.unshift(nsMsgs[i]);
                                }
                                finalPayload.messages = [...sMsgs, ...kept];
                                logger.warn(`[API Gateway] Context exceeded (${nPrompt}/${nCtx}). Emergency compaction: ${nsMsgs.length} → ${kept.length} msgs. Retrying...`);
                                retryCount++;
                                continue;
                            }
                            logDebugPayload('CONTEXT EXCEEDED UNRECOVERABLE', { status: response.status, body: errText });
                            throw new Error(`O tamanho do prompt excedeu o limite de contexto mesmo após compactação de emergência.`);
                        }
                        logger.warn(`[API Gateway] Erro 400 (Possível recusa de tools). Removendo tools e tentando novamente... Detalhes: ${errText}`);
                        delete finalPayload.tools;
                        delete finalPayload.tool_choice;
                        retryCount++;
                        continue;
                    }
                    
                    logDebugPayload('UPSTREAM REJECTED', { status: response.status, body: errText });
                    throw new Error(`Upstream error: ${response.status} - ${errText}`);
                }
                break;
            }

            if (!response || !response.ok) {
                logDebugPayload('UPSTREAM FAILURE', 'Target endpoint unreachable.');
                throw new Error(`Upstream error: Target endpoint unreachable.`);
            }

            if (stream) {
                const decoder = new TextDecoder();
                let buffer = '';
                
                let interceptingTool = false;
                let interceptedToolName = '';
                let interceptedToolArgs = '';
                let interceptedToolId = '';
                let chunkCache = [];
                let passThrough = false;
                let doneSent = false;
                
                try {
                    for await (const chunk of response.body) {
                        buffer += decoder.decode(chunk, { stream: true });
                        // Separação flexível por linha única lida perfeitamente com \n\n do OpenAI ou falhas do llama.cpp
                        let parts = buffer.split(/\r?\n/);
                        buffer = parts.pop(); 
                        
                        for (const part of parts) {
                            const trimmed = part.trim();
                            if (!trimmed) continue;
                            
                            if (trimmed === 'data: [DONE]') {
                                chunkCache.push(trimmed + '\n\n');
                                if (passThrough) res.write(trimmed + '\n\n');
                                doneSent = true;
                                continue;
                            }
                            
                            if (!trimmed.startsWith('data: ')) {
                                // Buggy engines podem retornar 200 OK com JSON puro de erro em vez de SSE
                                if (trimmed.startsWith('{"error"')) {
                                    logger.error('[API Gateway] Upstream retornou JSON de erro no stream: ' + trimmed);
                                    if (!headersSentToClient) {
                                        res.status(500).setHeader('Content-Type', 'application/json');
                                        res.write(trimmed);
                                        res.end();
                                        headersSentToClient = true;
                                    } else res.end();
                                    streamFinished = true;
                                    return;
                                }
                                if (passThrough) res.write(part + '\n');
                                continue;
                            }
                            
                            const dataStr = trimmed.replace(/^data:\s*/, '');
                            let dataObj;
                            try {
                                dataObj = JSON.parse(dataStr);
                            } catch(e) {
                                if (passThrough) res.write(trimmed + '\n\n');
                                continue;
                            }

                            // Strip reasoning_content (Qwen3 thinking tokens) before forwarding.
                            // OpenAI-compatible clients (Roo Code, etc.) only read delta.content —
                            // receiving reasoning_content-only chunks causes "no assistant messages".
                            let chunkToForward = trimmed;
                            if (dataObj.choices?.[0]?.delta?.reasoning_content !== undefined) {
                                delete dataObj.choices[0].delta.reasoning_content;
                                chunkToForward = 'data: ' + JSON.stringify(dataObj);
                            }

                            const delta = dataObj.choices?.[0]?.delta;
                            if (delta?.tool_calls?.length > 0) {
                                const tc = delta.tool_calls[0];
                                if (tc.function?.name) {
                                    if (tc.function.name === 'centraliza_web_search') {
                                        interceptingTool = true;
                                        interceptedToolName = tc.function.name;
                                        interceptedToolId = tc.id || `call_${Date.now()}`;
                                    } else {
                                        if (!passThrough) {
                                            logger.info(`[API Gateway] [AUDIT] Repassando ferramenta '${tc.function.name}' para o Roo Code.`);
                                        }
                                        passThrough = true;
                                        sendHeaders();
                                        chunkCache.forEach(c => res.write(c));
                                        chunkCache = [];
                                    }
                                }
                                if (interceptingTool && tc.function?.arguments) interceptedToolArgs += tc.function.arguments;
                            } else if (delta !== undefined) {
                                // Tem conteúdo (mesmo vazio) ou role. Abrir portas para o Roo!
                                if (!interceptingTool && !passThrough) {
                                    passThrough = true;
                                    sendHeaders();
                                    chunkCache.forEach(c => res.write(c));
                                    chunkCache = [];
                                }
                            }

                            if (interceptingTool) chunkCache.push(chunkToForward + '\n\n');
                            else if (passThrough) res.write(chunkToForward + '\n\n');
                            else chunkCache.push(chunkToForward + '\n\n');
                        }
                    }
                    
                    // Despejar qualquer buffer remanescente vital preso na memória
                    if (buffer.trim()) {
                        const trimmed = buffer.trim();
                        if (trimmed.startsWith('data: ') && passThrough) res.write(trimmed + '\n\n');
                    }
                    
                    if (interceptingTool && interceptedToolName === 'centraliza_web_search') {
                        let query = '';
                        try { query = JSON.parse(interceptedToolArgs).query; } catch(e) { query = interceptedToolArgs; }
                        
                        logger.info(`[API Gateway] [AUDIT] Ferramenta '${interceptedToolName}' acionada. Resolvendo e aguardando resposta...`);
                        const searchResults = await performWebSearch(query);
                        
                        finalPayload.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: interceptedToolId, type: 'function', function: { name: 'centraliza_web_search', arguments: interceptedToolArgs } }] });
                        finalPayload.messages.push({ role: 'tool', tool_call_id: interceptedToolId, name: 'centraliza_web_search', content: searchResults });
                        
                        if (currentIteration >= maxIterations) {
                            logger.warn(`[API Gateway] [AUDIT] Limite de segurança atingido (${maxIterations}/${maxIterations})! Quebrando o loop do modelo para evitar execuções infinitas.`);
                            if (!headersSentToClient) sendHeaders();
                            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "\n\n*[AVISO DO SISTEMA: O modelo atingiu o limite máximo de execuções encadeadas de ferramentas. O loop foi interrompido para sua proteção.]*" } }] })}\n\n`);
                            res.write('data: [DONE]\n\n');
                            res.end();
                            streamFinished = true;
                        } else {
                            retryCount = 0; 
                            continue; 
                        }
                    } else {
                        if (!headersSentToClient) sendHeaders();
                        if (!passThrough) chunkCache.forEach(c => res.write(c));
                        
                        // PREVENÇÃO CRÍTICA PARA O ROO CODE: Injetar manualmente o [DONE] final se o motor não o enviou
                        if (!doneSent) {
                             res.write('data: [DONE]\n\n');
                        }
                        res.end();
                        streamFinished = true;
                    }
                } catch (err) {
                    logger.warn('Stream response body error: ', err);
                    if (!headersSentToClient) res.status(500).json({ error: { message: err.message } });
                    else res.end();
                    streamFinished = true;
                }
            } else {
                const rawText = await response.text();
                if (!rawText.trim()) throw new Error('O motor de IA retornou uma resposta vazia.');
                
                try {
                    const dataObj = JSON.parse(rawText);
                    const tc = dataObj.choices?.[0]?.message?.tool_calls?.[0];
                    
                    if (tc && tc.function?.name === 'centraliza_web_search') {
                        let query = '';
                        try { query = JSON.parse(tc.function.arguments).query; } catch(e) { query = tc.function.arguments; }
                        
                        logger.info(`[API Gateway] [AUDIT] Ferramenta '${tc.function.name}' executada (non-stream).`);
                        const searchResults = await performWebSearch(query);
                        
                        finalPayload.messages.push(dataObj.choices[0].message);
                        finalPayload.messages.push({ role: 'tool', tool_call_id: tc.id, name: 'centraliza_web_search', content: searchResults });
                        
                        if (currentIteration >= maxIterations) {
                            logger.warn(`[API Gateway] [AUDIT] Limite de segurança de ${maxIterations} iterações atingido! Parando o agente (non-stream).`);
                            dataObj.choices[0].message.content = (dataObj.choices[0].message.content || '') + "\n\n*[AVISO DO SISTEMA: Loop interrompido. Limite máximo de chamadas de ferramenta alcançado.]*";
                            delete dataObj.choices[0].message.tool_calls;
                            res.setHeader('Content-Type', 'application/json');
                            res.send(JSON.stringify(dataObj));
                            streamFinished = true;
                        } else {
                            retryCount = 0;
                            continue;
                        }
                    } else {
                        res.setHeader('Content-Type', 'application/json');
                        res.send(rawText);
                        streamFinished = true;
                    }
                } catch (e) {
                    res.setHeader('Content-Type', 'application/json');
                    res.send(rawText);
                    streamFinished = true;
                }
            }
        }
    } catch (e) {
        logger.error('[API Gateway] Error routing completion request', e);
        if (e.name !== 'AbortError') {
            if (!res.headersSent) {
                // Padronização OpenAI Compatible rigorosa para extensões
                res.status(500).json({ error: { message: 'AI Gateway Error: ' + e.message, type: 'server_error', code: 500 } });
            } else {
                res.end();
            }
        }
    }
});

// --- API GATEWAY: MOCK OPENAI MODELS ---
// Essencial para evitar que extensões (Roo/Continue) congelem ao tentar validar a ligação.
// SEMPRE retorna 'centraliza-router' — o ID que o Roo Code e Continue.dev estão configurados
// para usar. Retornar o path GGUF causaria mismatch de validação nas extensões.
app.get('/v1/models', (req, res) => {
    res.json({
        object: 'list',
        data: [
            {
                id: 'centraliza-router',
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'centraliza'
            }
        ]
    });
});

// --- RAG (RETRIEVAL-AUGMENTED GENERATION) SYSTEM ---
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

// Basic in-memory document store
let globalDocuments = [];

app.post('/api/documents/upload', upload.single('document'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    // Check if limit of 5 documents has been reached
    if (globalDocuments.length >= 5) {
        return res.status(400).json({ error: 'Maximum limit of 5 documents reached. Please remove some files first.' });
    }

    try {
        logger.info(`[RAG] Processing document: ${req.file.originalname}`);
        let extractedText = '';

        if (req.file.mimetype === 'application/pdf') {
            const data = await pdfParse(req.file.buffer);
            extractedText = data.text;
        } else if (req.file.mimetype === 'text/plain') {
            extractedText = req.file.buffer.toString('utf8');
        } else if (req.file.originalname.endsWith('.docx')) {
            const result = await mammoth.extractRawText({ buffer: req.file.buffer });
            extractedText = result.value;
        } else {
            return res.status(400).json({ error: 'Unsupported file type. Use PDF, TXT or DOCX.' });
        }

        // Chunking the text (Basic naive chunking by ~1000 characters)
        const cleanText = extractedText.replace(/\n+/g, ' ').replace(/\s+/g, ' ');
        const chunkSize = 1000;
        const chunks = [];
        for (let i = 0; i < cleanText.length; i += chunkSize) {
            chunks.push(cleanText.substring(i, i + chunkSize));
        }

        globalDocuments.push({
            filename: req.file.originalname,
            chunks: chunks,
            uploadedAt: Date.now()
        });

        logger.info(`[RAG] Document indexed into ${chunks.length} chunks.`);
        res.json({ success: true, message: `Document ${req.file.originalname} processed.`, chunks: chunks.length, document: { filename: req.file.originalname, chunks: chunks.length, id: globalDocuments[globalDocuments.length-1].uploadedAt } });
    } catch (e) {
        logger.error('[RAG] Error processing document', e);
        res.status(500).json({ error: 'Failed to process document: ' + e.message });
    }
});

app.delete('/api/documents/:id', (req, res) => {
    const id = parseInt(req.params.id);
    globalDocuments = globalDocuments.filter(d => d.uploadedAt !== id);
    logger.info(`[RAG] Document ${id} cleared from memory.`);
    res.json({ success: true, message: 'Document removed.' });
});

app.delete('/api/documents', (req, res) => {
    globalDocuments = [];
    logger.info('[RAG] Document memory cleared.');
    res.json({ success: true, message: 'All documents cleared from memory.' });
});

app.get('/api/documents', (req, res) => {
    res.json(globalDocuments.map(d => ({ filename: d.filename, chunks: d.chunks.length, id: d.uploadedAt })));
});


// --- NATIVE INFERENCE ENGINE STATE ---
let activeLlamaProcess = null;
let currentLlamaPort = 8080;
let currentLlamaModel = null;
let currentLlamaCtx = 2048;

app.post('/api/inference/start', async (req, res) => {
    const { modelPath, ngl = 0, ctx = 2048, reasoningBudget = 2048 } = req.body;
    if (!modelPath) return res.status(400).json({ error: 'Missing model path.' });

    if (activeLlamaProcess) {
        // If the exact same model and context size are already running, skip spawn and just return ready
        if (currentLlamaModel === modelPath && currentLlamaCtx === ctx) {
             logger.info('[Llama.cpp] Engine already running with this model and ctx.');
             return res.json({ success: true, port: currentLlamaPort, message: 'Engine already running.' });
        }

        logger.info('[Llama.cpp] Terminating old engine to load new model or context size.');

        await new Promise(r => {
            if (os.platform() === 'win32') {
                const killCmd = activeLlamaProcess.pid
                    ? `taskkill /F /T /PID ${activeLlamaProcess.pid}`
                    : `taskkill /F /IM llama-server.exe`;
                exec(killCmd, () => setTimeout(r, 2000));
            } else {
                if (activeLlamaProcess.kill) activeLlamaProcess.kill('SIGKILL');
                else exec('pkill -9 llama-server', () => {});
                setTimeout(r, 2000);
            }
        });
        activeLlamaProcess = null;
    }

    const isWindows = os.platform() === 'win32';
    const binaryName = isWindows ? 'llama-server.exe' : 'llama-server';
    const args = ['-m', modelPath, '-c', String(ctx), '-ngl', String(ngl), '--port', String(currentLlamaPort), '--reasoning', 'off'];
    logDebugPayload('SPAWNING LLAMA.CPP', { binary: binaryName, args: args });

    try {
        const proc = spawn(binaryName, args, { stdio: 'pipe' });
        activeLlamaProcess = proc;

        proc.stdout.on('data', d => logger.info(`[Llama.cpp] ${d.toString().trim()}`));
        proc.stderr.on('data', d => logger.info(`[Llama.cpp ERR] ${d.toString().trim()}`));

        proc.on('error', (err) => {
            logger.error('[Llama.cpp] Spawn error. Binary missing?', err);
            if (activeLlamaProcess && activeLlamaProcess.pid === proc.pid) activeLlamaProcess = null;
        });

        currentLlamaModel = modelPath;
        currentLlamaCtx = ctx;

        proc.on('close', () => {
            logger.info('[Llama.cpp] Engine stopped.');
            if (activeLlamaProcess && activeLlamaProcess.pid === proc.pid) {
                 activeLlamaProcess = null;
                 currentLlamaModel = null;
                 currentLlamaCtx = 2048;
            }
        });

        // Wait up to 60 seconds for the server to be responsive
        let attempts = 0;
        const maxAttempts = 30; // 30 * 2000ms = 60s
        const checkHealth = async () => {
             attempts++;
             try {
                 const healthRes = await import('node-fetch').then(({default: fetch}) => fetch(`http://127.0.0.1:${currentLlamaPort}/health`));
                 const healthData = await healthRes.json();
                 if (healthData.status === 'ok') {
                      logger.info('[Llama.cpp] Engine is fully loaded and ready.');
                      return res.json({ success: true, port: currentLlamaPort, message: 'Engine running.' });
                 }
                 throw new Error('Loading model');
             } catch (err) {
                 if (attempts >= maxAttempts) {
                     logger.error('[Llama.cpp] Engine startup timeout.');
                     return res.status(500).json({ error: 'Engine startup timeout. The model might be too large or took too long to load.' });
                 }
                 if (!activeLlamaProcess) return res.status(500).json({ error: 'Engine crashed during startup.' });
                 setTimeout(checkHealth, 2000);
             }
        };

        // Delay the first check to give spawn time
        setTimeout(checkHealth, 1500);

    } catch (e) {
        logger.error('Failed to start llama-server', e);
        res.status(500).json({ error: 'Failed to start engine: ' + e.message });
    }
});

app.post('/api/inference/stop', async (req, res) => {
    if (activeLlamaProcess) {
        await new Promise(r => {
            if (os.platform() === 'win32') {
                const killCmd = activeLlamaProcess.pid
                    ? `taskkill /F /T /PID ${activeLlamaProcess.pid}`
                    : `taskkill /F /IM llama-server.exe`;
                exec(killCmd, () => setTimeout(r, 1000));
            } else {
                if (activeLlamaProcess.kill) activeLlamaProcess.kill('SIGKILL');
                else exec('pkill -9 llama-server', () => {});
                setTimeout(r, 1000);
            }
        });
        activeLlamaProcess = null;
        currentLlamaModel = null;
        res.json({ success: true, message: 'Engine stopped.' });
    } else {
        res.json({ success: true, message: 'No engine running.' });
    }
});

app.get('/api/inference/status', (req, res) => {
    res.json({ running: !!activeLlamaProcess, port: currentLlamaPort, model: currentLlamaModel, ctx: currentLlamaCtx });
});

app.post('/api/chat', async (req, res) => {
    const { ollamaTag, prompt, endpoint = 'http://127.0.0.1:11434/api/generate', options, system } = req.body;
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

    // Prepare the payload based on provided parameters
    const payload = { model: ollamaTag, prompt, stream: false };
    if (options) Object.assign(payload, { options });
    if (system) Object.assign(payload, { system });

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        res.json(data);
    } catch (e) { 
        logger.error('Chat error', e);
        res.status(500).json({ error: 'AI Server error: ' + e.message }); 
    }
});

// --- MAP-REDUCE CAPABILITY ---
app.post('/api/documents/analyze', async (req, res) => {
    const { userQuestion, modelId, engineType, ctxSize = 8192 } = req.body;
    
    if (globalDocuments.length === 0) {
        return res.status(400).json({ error: 'Nenhum documento em memória. Por favor, anexe um arquivo primeiro usando o clip de papel.' });
    }

    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    const longText = globalDocuments.map(doc => doc.chunks.join('\n\n')).join('\n\n---\n\n');

    // O tamanho do pedaço é calculado para usar 50% do contexto da IA disponível (em caracteres, multiplicando tokens por 4)
    const CHUNK_SIZE = Math.floor((ctxSize * 0.5) * 4);
    const chunks = [];
    for (let i = 0; i < longText.length; i += CHUNK_SIZE) {
        chunks.push(longText.slice(i, i + CHUNK_SIZE));
    }

    logger.info(`[Map-Reduce] Inciando análise. Documento tem ${chunks.length} pedaços. Modelo: ${modelId}, Motor: ${engineType}`);
    
    try {
        const summaries = [];
        const isLlama = engineType === 'llama.cpp';
        const url = isLlama ? `http://127.0.0.1:${currentLlamaPort}/completion` : 'http://127.0.0.1:11434/api/generate';

        for (const [index, chunk] of chunks.entries()) {
            logger.info(`[Map-Reduce] Lendo parte ${index + 1}/${chunks.length}...`);
            const mapPrompt = `Você é um assistente de IA extraindo dados essenciais de partes de um texto. Resuma o seguinte texto de forma concisa e preserve fatos importantes.\n\nTEXTO:\n${chunk}\n\nRESUMO:`;

            const payload = isLlama ? {
                prompt: mapPrompt,
                n_predict: Math.floor(ctxSize * 0.15),
                stream: false
            } : {
                model: modelId,
                prompt: mapPrompt,
                stream: false,
                options: { num_ctx: Math.floor(ctxSize * 0.6) }
            };

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) throw new Error(`Erro no motor (${response.status})`);
            const data = await response.json();
            summaries.push(isLlama ? data.content : data.response);
        }

        logger.info(`[Map-Reduce] Sintetizando ${summaries.length} resumos...`);
        const combinedSummaries = summaries.join('\n\n---\n\n');
        const finalPrompt = `Use os resumos abaixo extraídos do documento para responder detalhadamente à pergunta do usuário.\n\nRESUMOS DO DOCUMENTO:\n${combinedSummaries}\n\nPERGUNTA: ${userQuestion}\n\nRESPOSTA:`;

        const finalPayload = isLlama ? {
            prompt: finalPrompt,
            n_predict: Math.floor(ctxSize * 0.25),
            stream: false
        } : {
            model: modelId,
            prompt: finalPrompt,
            stream: false,
            options: { num_ctx: ctxSize }
        };

        const finalResponse = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(finalPayload)
        });

        const finalData = await finalResponse.json();
        const finalAnswer = isLlama ? finalData.content : finalData.response;
        
        res.json({ success: true, answer: finalAnswer, chunksProcessed: chunks.length });
    } catch (error) {
        logger.error('[Map-Reduce] Falha:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/launch', (req, res) => {
    const { type, modelPath, ollamaTag, params } = req.body;
    let cmd = '';
    
    if (type === 'ollama') {
        cmd = `ollama run ${ollamaTag}`;
    } else if (type === 'comfyui') {
        if (!config.comfyDir) return res.status(400).json({ error: 'ComfyUI path not set.' });
        cmd = `cd /d "${config.comfyDir}" && python main.py`;
    } else if (type === 'lm-studio') {
        cmd = `start lms.exe`;
    } else if (type === 'llama.cpp') {
        const threads = params?.threads || 4;
        const gpuLayers = params?.n_gpu_layers || 0;
        const ctx = params?.ctx_size || 2048;
        const prompt = params?.prompt || "You are a helpful AI assistant.";
        cmd = `llama-cli -m "${modelPath}" -t ${threads} -ngl ${gpuLayers} -c ${ctx} -p "${prompt.replace(/"/g, '\\"')}"`;
    }

    if (cmd) {
        logger.info(`Launching ${type}: ${cmd}`);
        exec(`start cmd /k "${cmd}"`, (err) => {
            if (err) return res.status(500).json({ error: 'Failed to launch: ' + err.message });
            res.json({ success: true, message: `Launching ${type}...` });
        });
    } else res.status(400).json({ error: 'Unsupported engine.' });
});

const activeDownloads = new Map();
const pendingCancels = new Set();
const lastProgress = new Map();

function finishDownload(modelName, options = { success: false }) {
    const entry = activeDownloads.get(modelName);
    if (!entry || entry.completed) return;
    entry.completed = true;
    activeDownloads.delete(modelName);
    lastProgress.delete(modelName);
    const isCancelled = options.cancelled || pendingCancels.has(modelName);
    pendingCancels.delete(modelName);
    logger.info(`[Download] Finished ${modelName} - success=${options.success}, cancelled=${isCancelled}, paused=${options.paused}`);
    io.emit('download-complete', { 
        model: modelName, 
        success: options.success || false, 
        cancelled: isCancelled,
        paused: options.paused || false 
    });
    cache.clear();
}

app.post('/api/download', (req, res) => {
    const { modelName } = req.body;
    if (activeDownloads.has(modelName)) return res.status(400).json({ error: 'Download already in progress.' });

    const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
    const abortController = new AbortController();
    activeDownloads.set(modelName, { abortController, completed: false, errorLines: [] });
    logger.info(`[Download] Started Ollama REST pull for ${modelName}`);
    io.emit('download-progress', { model: modelName, progress: -1 });
    res.json({ success: true });

    (async () => {
        try {
            const ollamaRes = await fetch('http://localhost:11434/api/pull', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: modelName, stream: true }),
                signal: abortController.signal
            });
            if (!ollamaRes.ok) throw new Error(`Ollama API ${ollamaRes.status}`);

            let buf = '';
            ollamaRes.body.on('data', (chunk) => {
                const entry = activeDownloads.get(modelName);
                if (!entry || entry.completed) { ollamaRes.body.destroy(); return; }
                buf += chunk.toString();
                const lines = buf.split('\n');
                buf = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    let d; try { d = JSON.parse(line); } catch { continue; }
                    if (d.error) { entry.errorLines.push(d.error); finishDownload(modelName, { success: false }); return; }
                    if (d.status === 'success') { finishDownload(modelName, { success: true }); return; }
                    if (d.total && d.completed !== undefined) {
                        const pct = Math.round((d.completed / d.total) * 100);
                        const prev = lastProgress.get(modelName);
                        if (prev === undefined || pct > prev || (pct === 0 && prev === -1)) {
                            lastProgress.set(modelName, pct);
                            io.emit('download-progress', { model: modelName, progress: pct });
                        }
                    } else if (!lastProgress.has(modelName) || lastProgress.get(modelName) === -1) {
                        lastProgress.set(modelName, -1);
                        io.emit('download-progress', { model: modelName, progress: -1 });
                    }
                }
            });
            await new Promise((resolve, reject) => {
                ollamaRes.body.on('end', resolve);
                ollamaRes.body.on('error', reject);
            });
            const entry = activeDownloads.get(modelName);
            if (entry && !entry.completed) finishDownload(modelName, { success: true });
        } catch (err) {
            if (err.name === 'AbortError' || err.type === 'aborted') return;
            logger.error(`[Download] Ollama pull failed: ${modelName}`, err);
            const entry = activeDownloads.get(modelName);
            if (entry) entry.errorLines.push(err.message);
            if (entry && !entry.completed) finishDownload(modelName, { success: false });
        }
    })();
});

app.post('/api/download/pause', (req, res) => {
    const { modelName } = req.body;
    const entry = activeDownloads.get(modelName);
    if (entry) {
        logger.info(`[Download] Pausing ${modelName}`);
        finishDownload(modelName, { success: false, paused: true });
        if (entry.abortController) entry.abortController.abort();
        if (entry.proc) {
            if (os.platform() === 'win32') exec(`taskkill /F /T /PID ${entry.proc.pid}`, () => {});
            else entry.proc.kill('SIGKILL');
        }
        res.json({ success: true });
    } else res.status(404).json({ error: 'Download not found' });
});

app.post('/api/download/cancel', (req, res) => {
    const { modelName } = req.body;
    const entry = activeDownloads.get(modelName);
    if (entry) {
        pendingCancels.add(modelName);
        logger.info(`[Download] Cancelling ${modelName}`);
        
        // Immediate UI update via finishDownload (emits cancelled: true)
        finishDownload(modelName, { success: false, cancelled: true });
        
        // Kill the process tree reliably
        if (entry.abortController) entry.abortController.abort();
        if (entry.proc) {
            if (os.platform() === 'win32') exec(`taskkill /F /T /PID ${entry.proc.pid}`, () => {});
            else entry.proc.kill('SIGKILL');
        }
        
        // Post-kill cleanup: Ollama RM + partial files
        setTimeout(() => {
            logger.info(`[Download] Starting deep cleanup for ${modelName}`);
            exec(`ollama rm ${modelName}`, (err) => {
                if (err) logger.warn(`[Download] ollama rm failed (expected if never finished manifest): ${err.message}`);
                
                // Deep scan for partial blobs
                const blobDir = path.join(os.homedir(), '.ollama', 'models', 'blobs');
                if (fs.existsSync(blobDir)) {
                    try {
                        const blobs = fs.readdirSync(blobDir);
                        let removedCount = 0;
                        blobs.forEach(f => {
                            if (f.endsWith('-partial') || f.endsWith('.partial')) {
                                try { 
                                    fs.unlinkSync(path.join(blobDir, f)); 
                                    removedCount++;
                                } catch (e) {}
                            }
                        });
                        logger.info(`[Download] Cleanup finished. Removed ${removedCount} partial blobs.`);
                    } catch (e) {
                        logger.error(`[Download] Blob cleanup failed`, e);
                    }
                }
                io.emit('models-updated');
                cache.clear();
            });
        }, 1500);
        res.json({ success: true });
    } else {
        // Entry not in activeDownloads — was already paused or finished.
        // Still emit cancel event so UI unblocks, and clean up Ollama blobs.
        logger.info(`[Download] Cancel of already-stopped ${modelName} — emitting cancelled and cleaning up`);
        io.emit('download-complete', { model: modelName, success: false, cancelled: true });
        exec(`ollama rm ${modelName}`, (err) => {
            if (err) logger.warn(`[Download] ollama rm (post-pause cleanup) failed: ${err.message}`);
            cache.clear();
            io.emit('models-updated');
        });
        res.json({ success: true });
    }
});

app.post('/api/download/hf', async (req, res) => {
    const { repo, modelName } = req.body;
    if (!repo || !modelName) return res.status(400).json({ error: 'Missing repo or modelName' });
    if (activeDownloads.has(modelName)) return res.status(400).json({ error: 'Download already in progress.' });

    try {
        const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

        const apiRes = await fetch(`https://huggingface.co/api/models/${repo}`);
        if (!apiRes.ok) return res.status(502).json({ error: `HuggingFace API error: ${apiRes.status}` });

        const apiData = await apiRes.json();
        const allGguf = (apiData.siblings || []).map(s => s.rfilename).filter(f => f.toLowerCase().endsWith('.gguf'));
        // Prefer single-file GGUFs; fall back to split shards (first shard only — user can pull rest manually)
        const singleGguf = allGguf.filter(f => !f.toLowerCase().includes('-of-'));
        const ggufFiles = singleGguf.length > 0 ? singleGguf : allGguf;

        const QUANT_PREF = ['Q4_K_M', 'Q5_K_M', 'Q4_K_S', 'Q4_0', 'Q5_0', 'Q8_0', 'IQ4_XS', 'IQ3_M', 'IQ4_NL', 'Q2_K'];
        let selectedFile = null;
        for (const q of QUANT_PREF) {
            selectedFile = ggufFiles.find(f => f.toUpperCase().includes(q));
            if (selectedFile) break;
        }
        if (!selectedFile && ggufFiles.length > 0) selectedFile = ggufFiles[0];
        if (!selectedFile) return res.status(404).json({ error: `No GGUF file found in ${repo}` });

        const downloadUrl = `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(selectedFile)}`;
        const destPath = path.join(config.centralDir, selectedFile);
        const partPath = destPath + '.part';

        logger.info(`[HF Download] ${modelName} → ${selectedFile} from ${repo}`);
        activeDownloads.set(modelName, { completed: false, errorLines: [] });
        res.json({ success: true, file: selectedFile });

        (async () => {
            try {
                const dlRes = await fetch(downloadUrl);
                if (!dlRes.ok) throw new Error(`HTTP ${dlRes.status} from HuggingFace`);

                const totalBytes = parseInt(dlRes.headers.get('content-length') || '0', 10);
                let downloadedBytes = 0;
                let lastPct = -1;

                const fileStream = require('fs').createWriteStream(partPath);
                dlRes.body.on('data', (chunk) => {
                    const entry = activeDownloads.get(modelName);
                    if (!entry || entry.completed) { dlRes.body.destroy(); return; }
                    downloadedBytes += chunk.length;
                    fileStream.write(chunk);
                    if (totalBytes > 0) {
                        const pct = Math.round((downloadedBytes / totalBytes) * 100);
                        if (pct !== lastPct) { lastPct = pct; io.emit('download-progress', { model: modelName, progress: pct }); }
                    } else {
                        io.emit('download-progress', { model: modelName, progress: -1 });
                    }
                });

                await new Promise((resolve, reject) => {
                    dlRes.body.on('end', resolve);
                    dlRes.body.on('error', reject);
                });
                fileStream.end();
                await new Promise(resolve => fileStream.on('finish', resolve));

                require('fs').renameSync(partPath, destPath);
                finishDownload(modelName, { success: true });
                io.emit('models-updated');
                logger.info(`[HF Download] Complete: ${destPath}`);
            } catch (err) {
                logger.error(`[HF Download] Failed: ${modelName}`, err);
                const entry = activeDownloads.get(modelName);
                if (entry) entry.errorLines.push(err.message);
                finishDownload(modelName, { success: false });
                if (require('fs').existsSync(partPath)) try { require('fs').unlinkSync(partPath); } catch (_) {}
            }
        })();
    } catch (err) {
        logger.error(`[HF Download] Setup failed: ${modelName}`, err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/models/rename', async (req, res) => {
    const { oldPath, newName } = req.body;
    const newPath = path.join(path.dirname(oldPath), newName + path.extname(oldPath));
    try {
        await promisify(fs.rename)(oldPath, newPath);
        cache.clear();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/models/move', async (req, res) => {
    const { oldPath, newDir } = req.body;
    const newPath = path.join(newDir, path.basename(oldPath));
    try {
        await promisify(fs.rename)(oldPath, newPath);
        cache.clear();
        res.json({ success: true });
    } catch (e) {
        try {
            await promisify(fs.copyFile)(oldPath, newPath);
            await promisify(fs.unlink)(oldPath);
            cache.clear();
            res.json({ success: true, fallback: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    }
});

app.delete('/api/models', async (req, res) => {
    const { modelPath, ollamaTag, centralPath } = req.body;
    logger.info(`[Delete] Request for: ${ollamaTag || modelPath}`);
    try {
        if (centralPath && fs.existsSync(centralPath)) {
            await promisify(fs.unlink)(centralPath);
            cache.clear();
            io.emit('models-updated');
            return res.json({ success: true });
        }
        if (ollamaTag) {
            const proc = activeDownloads.get(ollamaTag);
            if (proc) {
                if (os.platform() === 'win32') exec(`taskkill /F /T /PID ${proc.pid}`);
                else proc.kill('SIGKILL');
                activeDownloads.delete(ollamaTag);
            }
            // Wait for ollama rm to finish BEFORE responding, so the frontend
            // sees the model gone when it immediately re-fetches.
            await promisify(exec)(`ollama rm ${ollamaTag}`);
            cache.clear();
            io.emit('models-updated');
            return res.json({ success: true });
        }
        if (modelPath && fs.existsSync(modelPath)) {
            // Hugging Face cache uses a special structure:
            //   hub/models--org--name/blobs/<sha>      (actual data, no extension)
            //   hub/models--org--name/snapshots/HASH/  (may be hardlinks or copies on Windows)
            // Deleting just the snapshot file leaves the blob behind and HF will
            // reconstruct the link. We must remove the ENTIRE models--xxx folder.
            const hfMatch = modelPath.match(/^(.*?models--[^/\\]+)/i);
            if (hfMatch) {
                const modelCacheDir = hfMatch[1];
                logger.info(`[Delete] HF cache folder to remove: ${modelCacheDir}`);
                fs.rmSync(modelCacheDir, { recursive: true, force: true });
                logger.info(`[Delete] HF cache folder removed successfully`);
            } else {
                logger.info(`[Delete] Unlinking file: ${modelPath}`);
                await promisify(fs.unlink)(modelPath);
            }
            cache.clear();
            io.emit('models-updated');
            return res.json({ success: true });
        }
        res.status(404).json({ error: 'Model not found' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/models/sanity-check', async (req, res) => {
    const linkDir = path.join(config.centralDir, 'Centraliza.ai');
    if (!fs.existsSync(linkDir)) return res.json({ cleaned: 0 });
    let cleaned = 0;
    const clean = (d) => {
        fs.readdirSync(d, {withFileTypes:true}).forEach(e => {
            const p = path.join(d, e.name);
            if (e.isDirectory()) clean(p);
            else { try { fs.statSync(p); } catch(err) { fs.unlinkSync(p); cleaned++; } }
        });
    };
    try { clean(linkDir); cache.clear(); } catch(e) {}
    res.json({ success: true, cleaned });
});

app.get('/api/system/disk', async (req, res) => {
    const cached = cache.get('system-disk');
    if (cached) return res.json(cached);
    try {
        const diskPath = path.parse(process.cwd()).root;
        const disk = await checkDiskSpace(diskPath);
        const linkDir = path.join(config.centralDir, 'Centraliza.ai');
        const getDirSize = (d) => {
            if (!fs.existsSync(d)) return 0;
            let total = 0;
            fs.readdirSync(d, {withFileTypes:true}).forEach(e => {
                const p = path.join(d, e.name);
                if (e.isDirectory()) total += getDirSize(p);
                else { try { total += fs.statSync(p).size; } catch(err) {} }
            });
            return total;
        };
        const centralSize = getDirSize(linkDir);
        const result = { total: disk.size, free: disk.free, used: disk.size - disk.free, centraliza: centralSize, others: (disk.size - disk.free) - centralSize };
        cache.set('system-disk', result, 15000); // 15s cache
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/open-folder', (req, res) => {
    const { folderPath } = req.body;
    if (os.platform() === 'win32') {
        // Resolve symlinks so Explorer can actually navigate to the real location
        let resolvedPath = folderPath;
        try {
            resolvedPath = fs.realpathSync(folderPath);
        } catch(e) {
            // If realpathSync fails (e.g. file deleted), fall back to dirname
            resolvedPath = path.dirname(folderPath);
        }
        const cleanPath = resolvedPath.replace(/\//g, '\\');
        // If it points to a file, open the parent folder with the file selected
        let explorerArg;
        try {
            const stat = fs.statSync(cleanPath);
            explorerArg = stat.isDirectory() ? `"${cleanPath}"` : `/select,"${cleanPath}"`;
        } catch(e) {
            // File doesn't exist, just open the parent
            explorerArg = `"${path.dirname(cleanPath)}"`;
        }
        exec(`explorer.exe ${explorerArg}`);
        const targetDir = (() => { try { return fs.statSync(cleanPath).isDirectory() ? cleanPath : path.dirname(cleanPath); } catch(e) { return path.dirname(cleanPath); } })();
        const psFocus = `powershell.exe -Command "$path = '${targetDir}'; $wshell = New-Object -ComObject WScript.Shell; $explorer = New-Object -ComObject Shell.Application; $window = $explorer.Windows() | Where-Object { try { $_.Document.Folder.Self.Path.ToLower() -eq $path.ToLower() } catch { $false } } | Select-Object -First 1; if ($window) { $wshell.AppActivate($window.HWND) } else { $wshell.AppActivate('Explorador de Arquivos'); $wshell.AppActivate('File Explorer') }"`;
        setTimeout(() => { exec(psFocus); }, 1000);
    } else exec(`open -R "${folderPath}"`);
    res.json({ success: true });
});

// --- CENTRALIZA CODER (AUTO-SYNC SYSTEM) ---
function getCoderStatus() {
    const coderDir = path.join(__dirname, 'data', 'free-claude-code');
    // A instalação é confirmada pela presença do repositório git
    const isInstalled = fs.existsSync(path.join(coderDir, '.git'));
    let version = 'unknown';
    if (isInstalled) {
        try {
            const pkgJsonPath = path.join(coderDir, 'package.json');
            if (fs.existsSync(pkgJsonPath)) {
                version = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version || '1.0.0';
            }
        } catch(e) {
            logger.warn('[Coder Status] Não foi possível ler o package.json para obter a versão.', e);
        }
    }
    return { installed: isInstalled, path: coderDir, version };
}

async function syncCoder(isAuto = false) {
    const dataDir = path.join(__dirname, 'data');
    const coderDir = path.join(dataDir, 'free-claude-code');
    const repoUrl = 'https://github.com/Alishahryar1/free-claude-code.git';

    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    logger.info(`[Coder Sync] Starting ${isAuto ? 'automatic ' : ''}synchronization process.`);
    if (!isAuto) io.emit('coder-sync-progress', { status: 'Iniciando sincronização...', progress: 10 });

    const runCmd = (cmd, cwd, silentError = false) => new Promise((resolve, reject) => {
        exec(cmd, { cwd }, (err, stdout, stderr) => {
            if (err) {
                if (!silentError) {
                    logger.error(`[Coder Sync] Cmd Failed: ${cmd}`, err);
                }
                reject(err);
            } else resolve(stdout);
        });
    });

    try {
        if (fs.existsSync(path.join(coderDir, '.git'))) {
            if (!isAuto) io.emit('coder-sync-progress', { status: 'Buscando atualizações no GitHub...', progress: 30 });
            await runCmd('git pull', coderDir);
        } else {
            if (!isAuto) io.emit('coder-sync-progress', { status: 'Clonando repositório...', progress: 30 });
            await runCmd(`git clone ${repoUrl} free-claude-code`, dataDir);
        }

        if (!isAuto) io.emit('coder-sync-progress', { status: 'Instalando Node packages (se existirem)...', progress: 50 });
        await runCmd('npm install', coderDir, true).catch(() => {});

        if (!isAuto) io.emit('coder-sync-progress', { status: 'Instalando CLI do Claude Code globalmente...', progress: 65 });
        await runCmd('npm install -g @anthropic-ai/claude-code', coderDir, true).catch(err => {
            logger.warn('[Coder Sync] Aviso: Falha ao instalar @anthropic-ai/claude-code globalmente. Talvez precise de permissões de Administrador.', err.message);
        });

        if (!isAuto) io.emit('coder-sync-progress', { status: 'Configurando ambiente Python (FastAPI/Uvicorn)...', progress: 85 });
        
        const isWin = os.platform() === 'win32';
        const setupCmd = isWin 
            ? 'pip install -r requirements.txt || uv pip install -r requirements.txt || pip install fastapi uvicorn httpx pydantic'
            : 'pip3 install -r requirements.txt || uv pip install -r requirements.txt || pip3 install fastapi uvicorn httpx pydantic';
            
        await runCmd(setupCmd, coderDir, true).catch((err) => {
            logger.warn('[Coder Sync] Aviso: Falha ao instalar dependências Python. Verifique se o Python/pip estão instalados.', err.message);
        });

        if (!isAuto) io.emit('coder-sync-progress', { status: 'Pronto!', progress: 100 });
        logger.info(`[Coder Sync] ${isAuto ? 'Auto-' : ''}Sync completed successfully.`);

        const newStatus = getCoderStatus();
        if (!isAuto) {
            // Emite um evento para todos os clientes atualizarem o status
            io.emit('coder-status-updated', newStatus);
        }
        return { success: true, message: 'Sincronização concluída com sucesso!', status: newStatus };
    } catch (error) {
        logger.error('[Coder Sync] Critical Error:', error);
        if (!isAuto) io.emit('coder-sync-progress', { status: `Erro: ${error.message}`, progress: -1 });
        throw error;
    }
}

app.post('/api/coder/sync', async (req, res) => {
    try {
        const result = await syncCoder(false);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/coder/status', (req, res) => {
    res.json(getCoderStatus());
});

// --- VS CODE / EDITOR INTEGRATION ---
app.post('/api/coder/setup-continue', (req, res) => {
    try {
        const continueDir = path.join(os.homedir(), '.continue');
        const configJsonPath = path.join(continueDir, 'config.json');
        const configYamlPath = path.join(continueDir, 'config.yaml');
        const configYmlPath = path.join(continueDir, 'config.yml');
        
        let targetConfigPath = configJsonPath;
        let isYaml = false;

        if (fs.existsSync(configYamlPath)) {
            targetConfigPath = configYamlPath;
            isYaml = true;
        } else if (fs.existsSync(configYmlPath)) {
            targetConfigPath = configYmlPath;
            isYaml = true;
        }

        if (!fs.existsSync(continueDir)) {
            fs.mkdirSync(continueDir, { recursive: true });
        }

        if (isYaml) {
            let yamlContent = fs.readFileSync(targetConfigPath, 'utf8');
            
            // Insere o modelo no array "models:" se não existir
            if (!yamlContent.includes('Centraliza.ai Gateway')) {
                const modelsRegex = /^models:\s*$/m;
                const newModelYaml = `\n  - name: Centraliza.ai Gateway\n    provider: openai\n    model: centraliza-router\n    apiBase: http://localhost:4000/v1\n    apiKey: centraliza-local`;
                if (modelsRegex.test(yamlContent)) {
                    yamlContent = yamlContent.replace(modelsRegex, `models:${newModelYaml}`);
                } else {
                    yamlContent += `\nmodels:${newModelYaml}`;
                }
            }

            // Substitui ou adiciona o modelo de Autocomplete (Tab)
            const tabRegex = /^tabAutocompleteModel:\s*\n(?:^[ \t]+.*\n?|^\s*\n)*/m;
            const newTabModelYaml = `tabAutocompleteModel:\n  name: Centraliza.ai Autocomplete\n  provider: openai\n  model: centraliza-router\n  apiBase: http://localhost:4000/v1\n  apiKey: centraliza-local\n`;
            
            if (tabRegex.test(yamlContent)) {
                yamlContent = yamlContent.replace(tabRegex, newTabModelYaml);
            } else {
                yamlContent += `\n${newTabModelYaml}`;
            }
            
            fs.writeFileSync(targetConfigPath, yamlContent);
        } else {
            let config = {};
            if (fs.existsSync(targetConfigPath)) {
                try { config = JSON.parse(fs.readFileSync(targetConfigPath, 'utf8')); } catch (e) {}
            }
            
            if (!config.models) config.models = [];
            
            const centralizaModel = {
                title: "Centraliza.ai Gateway",
                provider: "openai",
                model: "centraliza-router",
                apiBase: "http://localhost:4000/v1",
                apiKey: "centraliza-local"
            };

            config.models = config.models.filter(m => m.title !== "Centraliza.ai Gateway");
            config.models.push(centralizaModel);

            config.tabAutocompleteModel = {
                title: "Centraliza.ai Autocomplete",
                provider: "openai",
                model: "centraliza-router",
                apiBase: "http://localhost:4000/v1",
                apiKey: "centraliza-local"
            };

            fs.writeFileSync(targetConfigPath, JSON.stringify(config, null, 2));
        }
        logger.info('[VS Code] Continue.dev configurado com sucesso via automação.');
        
        res.json({ 
            success: true, 
            message: 'Continue.dev configurado com sucesso! Abra o VS Code para usar.',
            installUri: 'vscode:extension/Continue.continue'
        });
    } catch (err) {
        logger.error('[VS Code] Erro ao configurar Continue.dev', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/coder/setup-roo', (req, res) => {
    // O Roo Code usa a globalStorage do VS Code que não é segura de editar por fora.
    // Portanto, enviamos o helper com a URL de deep-link e as variáveis exatas para UI exibir.
    res.json({
        success: true,
        installUri: 'vscode:extension/RooPlay.roo-cline',
        instructions: {
            apiProvider: 'OpenAI Compatible',
            baseUrl: 'http://localhost:4000/v1',
            apiKey: 'centraliza-local',
            modelId: 'centraliza-router'
        }
    });
});

const distPath = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.use((req, res, next) => {
        // Se for um pedido para a API ou Gateway, devolvemos 404 em JSON (evita crashes silenciosos nos clientes OpenAI)
        // Se for qualquer outra coisa (navegador), devolvemos o React (index.html)
        if (!req.path.startsWith('/api') && !req.path.startsWith('/v1')) {
            res.sendFile(path.join(distPath, 'index.html'));
        } else {
            res.status(404).json({ error: { message: 'Endpoint not found in Centraliza API/Gateway.', type: 'invalid_request_error' } });
        }
    });
}

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.on('connection', (socket) => {
    logger.info('Client connected via WebSocket');
    socket.on('test-progress', () => {
        let p = 0;
        const iv = setInterval(() => {
            p += 10;
            io.emit('download-progress', { model: 'TEST_MODEL_CONNECTION', progress: p });
            if (p >= 100) { clearInterval(iv); io.emit('download-complete', { model: 'TEST_MODEL_CONNECTION', success: true }); }
        }, 300);
    });
});

async function probeExistingLlamaEngine() {
    if (!config.activeRouterModel || !config.activeRouterModel.toLowerCase().endsWith('.gguf')) return;
    try {
        const resp = await fetch(`http://127.0.0.1:${currentLlamaPort}/health`, { signal: AbortSignal.timeout(2000) });
        if (resp.ok) {
            logger.info(`[Llama.cpp] Engine já a correr na porta ${currentLlamaPort}. Reconectando para modelo: ${path.basename(config.activeRouterModel)}`);
            activeLlamaProcess = { pid: null, isExternal: true };
            currentLlamaModel = config.activeRouterModel;
            currentLlamaCtx = config.vramShieldLimit || 32768;
        }
    } catch(e) {
        // Nenhum motor a correr — normal ao iniciar
    }
}

if (require.main === module) {
    server.listen(4000, () => {
        logger.info('Centraliza.ai on http://localhost:4000');
        probeExistingLlamaEngine().catch(() => {});
        syncCoder(true).catch(() => {}); // Auto-sync invisível ao iniciar
    });
}
module.exports = { app, server };
