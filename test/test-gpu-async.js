#!/usr/bin/env node
// 模拟测试 GPU/NPU async chain 行为 (多加速器 provider 架构)
// 用法: node test-gpu-async.js [delay_ms]
// delay_ms: 模拟 nvidia-smi 延迟（默认 6000 = 6秒）

const DELAY = parseInt(process.argv[2]) || 6000;
const INTERVAL = 10000; // 模拟 tick 间隔 10s
const TTL = 30000;

const FAKE_NVIDIA_CSV = '0, NVIDIA GeForce RTX 3080, 45, 2048, 10240, 65, 120.5, 320.0, GPU-abc-123\n1, NVIDIA GeForce RTX 3080, 80, 8192, 10240, 72, 250.3, 320.0, GPU-def-456';
const FAKE_APPS_CSV = '12345, GPU-abc-123, 2048\n12346, GPU-def-456, 4096';

// Simulated Ascend NPU info output (910B, npu-smi 26.x: chip line has a single chip id, HBM column present)
const FAKE_NPU_INFO = `+-----------------------------------------------------------------------------------+
| npu-smi 23.0.0                       Version: 23.0.0                              |
+-------------------------------+-----------------+------------------------------------------------------+
| NPU   Name             | Health        | Power(W)  Temp(C)           Hugepages-Usage(page)          |
| Chip  Device           | Bus-Id        | AICore(%) Memory-Usage(MB)                                 |
+========================+===============+==============================================================+
| 0     Ascend 910B3     | OK            | 285.0     52                1232 / 1232                    |
| 0                      | 0000:C1:00.0  | 87        45312 / 65536                                    |
+========================+===============+==============================================================+
| 1     Ascend 910B3     | OK            | 290.0     48                1232 / 1232                    |
| 0                      | 0000:81:00.0  | 15        2048 / 65536                                     |
+-----------------------------------------------------------------------------------+`;

// Simulated Ascend NPU info output (310P, npu-smi 24.x: physical card id 1536 shared by both chips,
// chip line carries "chip device" ids, power is NA, no HBM column)
const FAKE_NPU_INFO_310P = `+--------------------------------------------------------------------------------------------------------+
| npu-smi v1.0                                     Version: 24.1.rc4.b999                                |
+-------------------------------+-----------------+------------------------------------------------------+
| NPU     Name                  | Health          | Power(W)     Temp(C)           Hugepages-Usage(page) |
| Chip    Device                | Bus-Id          | AICore(%)    Memory-Usage(MB)                        |
+===============================+=================+======================================================+
| 1536    310P1                 | OK              | NA           51                0     / 0             |
| 0       0                     | 0000:07:00.0    | 0            1486 / 89608                            |
+-------------------------------+-----------------+------------------------------------------------------+
| 1536    310P1                 | OK              | NA           50                0     / 0             |
| 1       1                     | 0000:07:00.0    | 42           1585 / 89085                            |
+===============================+-----------------+------------------------------------------------------+
+-------------------------------+-----------------+------------------------------------------------------+
| NPU     Chip                  | Process id      | Process name             | Process memory(MB)        |
+===============================+=================+======================================================+
| No running processes found in NPU 1536                                                                 |
+===============================+=================+======================================================+`;

// ── 模拟 extension.js 的多加速器状态变量 ──
let _gpuCache = [];
let _gpuCacheTime = 0;
let _gpuState = '';
let _gpuFirstCall = false;
let _smiChainRunning = false;
let _accelProviders = [];
let _accelInitialized = false;
let _accelProcMap = {};
let _accelMyIndices = [];

function dbg(msg) { console.log('[' + new Date().toISOString().slice(11, 23) + '] ' + msg); }

function parseNvidiaCsv(stdout) {
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const [idx, name, util, memUsed, memTotal, temp, pd, pl, uuid] = line.split(',').map(s => s.trim());
    return { idx: parseInt(idx), name, uuid: uuid || '', util: parseInt(util), memUsed: parseInt(memUsed), memTotal: parseInt(memTotal), temp: parseInt(temp), power: isNaN(parseFloat(pd)) ? null : { draw: parseFloat(pd).toFixed(0), limit: parseFloat(pl).toFixed(0) }, type: 'nvidia', devType: 'GPU' };
  });
}

function parseNpuSmiInfo(stdout) {
  const devices = [];
  const lines = stdout.split('\n');
  let cur = null;
  let inDeviceSection = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('|') && /NPU\b.*\bName/.test(t) && /Power|Temp/.test(t)) { inDeviceSection = true; continue; }
    if (t.startsWith('|') && /Process\s+id/i.test(t)) { inDeviceSection = false; continue; }
    if (t.startsWith('|') && inDeviceSection && !t.includes('---') && !t.includes('===') && !t.includes('npu-smi')) {
      const rawCells = t.split('|').map(s => s.trim()).filter(Boolean);
      if (rawCells.length >= 1 && /^\d/.test(rawCells[0])) {
        const c1 = rawCells[0] || '';
        const c2 = rawCells[1] || '';
        const c3 = rawCells[2] || '';
        const splitFields = (s) => s.replace(/\s*\/\s*/g, '/').split(/\s{2,}/).map(x => x.trim());
        const isChipLine = /^\d+(\s+\d+)?$/.test(c1.trim());
        if (!isChipLine) {
          const c1Parts = c1.split(/\s{2,}/);
          if (c1Parts.length >= 2 && /^\d+$/.test(c1Parts[0].trim())) {
            if (cur) devices.push(cur);
            const name = c1Parts.slice(1).join(' ').trim();
            const c3Fields = splitFields(c3);
            const powerNum = parseFloat(c3Fields[0] || '');
            const temp = parseInt(c3Fields[1]) || 0;
            const memStr = c3Fields[2] || '';
            const memParts = memStr.split('/').map(s => parseInt(s.trim()) || 0);
            cur = { idx: parseInt(c1Parts[0].trim()), name: name || 'Ascend', util: 0, memUsed: memParts[0] || 0, memTotal: memParts[1] || 0, temp, power: isNaN(powerNum) ? null : { draw: powerNum.toFixed(0), limit: '?' }, type: 'ascend', devType: 'NPU', uuid: '', _cardId: parseInt(c1Parts[0].trim()), _chipId: 0 };
          }
        } else if (cur) {
          cur._chipId = parseInt(c1.trim().split(/\s+/)[0]) || 0;
          const c3Fields = splitFields(c3);
          const aiCore = parseInt(c3Fields[0]) || 0;
          if (aiCore > 0) cur.util = aiCore;
          const memStr2 = c3Fields[1] || '';
          const memParts2 = memStr2.split('/').map(s => parseInt(s.trim()) || 0);
          if (memParts2.length >= 2 && memParts2[1] > 0) { cur.memUsed = memParts2[0]; cur.memTotal = memParts2[1]; }
          const hbmStr = c3Fields[2] || '';
          const hbmParts = hbmStr.split('/').map(s => parseInt(s.trim()) || 0);
          if (hbmParts.length >= 2 && hbmParts[1] > 0) { cur.memUsed = hbmParts[0]; cur.memTotal = hbmParts[1]; }
        }
      }
    }
  }
  if (cur) devices.push(cur);
  if (devices.length && devices.some((d, i) => d.idx !== i)) {
    devices.forEach((d, i) => { d.idx = i; });
  }
  return devices;
}

const ASCEND_POWER_LIMITS = {
  '310P1': 90, '310P3': 72,
  '910A': 310, '910B': 265, '910B1': 430, '910B2': 420, '910B3': 350, '910B4': 310, '910C': 350,
};

function applyAscendPowerLimits(devices) {
  for (const d of devices) {
    if (!d.power) continue;
    const last = (d.name || '').split(/\s+/).pop();
    const limit = ASCEND_POWER_LIMITS[d.name] !== undefined ? ASCEND_POWER_LIMITS[d.name] : ASCEND_POWER_LIMITS[last];
    d.power.limit = limit !== undefined ? String(limit) : '?';
  }
}

function enrichAscendPower(devices, done) {
  applyAscendPowerLimits(devices);
  const naCards = new Map();
  for (const d of devices) {
    if (!d.power && d._cardId !== undefined) {
      if (!naCards.has(d._cardId)) naCards.set(d._cardId, []);
      naCards.get(d._cardId).push(d);
    }
  }
  if (naCards.size === 0) return done();
  let pending = naCards.size;
  for (const [cardId, devs] of naCards) {
    mockExecFile('npu-smi', ['info', '-t', 'power', '-i', String(cardId)], { timeout: 5000 }, (err, stdout) => {
      if (!err && stdout) {
        const powers = [...String(stdout).matchAll(/NPU Real-time Power\(W\)\s*:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
        const chips = [...String(stdout).matchAll(/Chip ID\s*:\s*(\d+)/g)].map(m => parseInt(m[1]));
        for (let i = 0; i < powers.length; i++) {
          const d = (chips.length === powers.length && devs.find(x => x._chipId === chips[i])) || devs[i];
          if (d && !isNaN(powers[i]) && !d.power) d.power = { draw: powers[i].toFixed(0), limit: '?' };
        }
        applyAscendPowerLimits(devs);
      }
      if (--pending <= 0) done();
    });
  }
}

// Mock execFile: 延迟后返回假数据
function mockExecFile(cmd, args, opts, cb) {
  const query = args[0] || '';
  let output = '';
  if (cmd === 'nvidia-smi') {
    if (query.includes('--query-gpu=index,name')) output = FAKE_NVIDIA_CSV;
    else if (query.includes('--query-compute-apps')) output = FAKE_APPS_CSV;
  } else if (cmd === 'npu-smi') {
    if (query === 'info' && !args.includes('-t')) output = process.env.NPU_310P ? FAKE_NPU_INFO_310P : FAKE_NPU_INFO;
    else if (query === 'info' && args.includes('-t') && args.includes('power')) {
      const cardId = args[args.indexOf('-i') + 1];
      output = `\tNPU ID                         : ${cardId}\n\tChip Count                     : 2\n\n\tNPU Real-time Power(W)         : 65.4\n\tChip ID                        : 0\n\n\tNPU Real-time Power(W)         : 65.1\n\tChip ID                        : 1\n`;
    }
  }

  dbg(`  [mock] ${cmd} 启动 (${query?.slice(0, 40)}...) delay=${DELAY}ms`);
  
  const timer = setTimeout(() => {
    dbg(`  [mock] ${cmd} 返回`);
    cb(null, output);
  }, DELAY);

  // 模拟超时
  if (opts.timeout && DELAY > opts.timeout) {
    clearTimeout(timer);
    setTimeout(() => {
      dbg(`  [mock] ${cmd} 超时 (${opts.timeout}ms)`);
      cb(new Error('ETIMEDOUT'));
    }, opts.timeout);
  }
}

// ── Mock Providers ──
const MockNvidiaProvider = {
  type: 'nvidia', label: 'NVIDIA GPU', envVar: 'CUDA_VISIBLE_DEVICES',
  detect() { return true; },
  getDevices(cb) {
    mockExecFile('nvidia-smi', ['--query-gpu=index,name,...', '--format=csv,noheader,nounits'], { timeout: 15000 }, (err, stdout) => {
      if (err) return cb(err, []);
      try { cb(null, parseNvidiaCsv(stdout)); } catch (e) { cb(e, []); }
    });
  },
  getProcInfo(cb) { cb(null, { map: {}, myIndices: [] }); }
};

const MockAscendProvider = {
  type: 'ascend', label: 'Ascend NPU', envVar: 'ASCEND_RT_VISIBLE_DEVICES',
  detect() { return true; },
  getDevices(cb) {
    mockExecFile('npu-smi', ['info'], { timeout: 15000 }, (err, stdout) => {
      if (err) return cb(err, []);
      let devices;
      try { devices = parseNpuSmiInfo(stdout || ''); } catch (e) { return cb(e, []); }
      enrichAscendPower(devices, () => cb(null, devices));
    });
  },
  getProcInfo(cb) { cb(null, { map: {}, myIndices: [] }); }
};

// ── Unified refresh (multi-provider aggregation) ──
function refreshGpuChain() {
  if (_smiChainRunning) return;
  _accelProviders = [MockNvidiaProvider, MockAscendProvider];
  _smiChainRunning = true;
  const providerCount = _accelProviders.length;
  const providerResults = new Array(providerCount).fill(null).map(() => ({ devices: [], procInfo: null }));
  let pending = providerCount;

  const finalize = () => {
    const allDevices = [];
    let globalOffset = 0;
    for (let pi = 0; pi < providerCount; pi++) {
      const result = providerResults[pi];
      for (const d of result.devices) { d.idx = globalOffset + d.idx; allDevices.push(d); }
      globalOffset += result.devices.length;
    }
    _smiChainRunning = false;
    _gpuCache = allDevices;
    _gpuCacheTime = Date.now();
    if (_gpuState !== 'fresh') { dbg('accelerator snapshot fresh (' + allDevices.length + ' devices)'); _gpuState = 'fresh'; }
    if (_onGpuReady) { _onGpuReady(); _onGpuReady = null; }
    if (_onChainDone) { _onChainDone(); _onChainDone = null; }
  };

  _accelProviders.forEach((provider, pi) => {
    provider.getDevices((err, devices) => {
      if (err || !devices) { dbg(provider.label + ' error: ' + err?.message); providerResults[pi] = { devices: [], procInfo: null }; pending--; if (pending <= 0) finalize(); return; }
      provider.getProcInfo((err2, procInfo) => { providerResults[pi] = { devices, procInfo }; pending--; if (pending <= 0) finalize(); });
    });
  });
}

function getAllGpus() {
  refreshGpuChain();
  if (_gpuCacheTime > 0 && Date.now() - _gpuCacheTime > TTL) {
    dbg('⚠ TTL expired! clearing cache');
    _gpuCache = [];
    _gpuCacheTime = 0;
  }
  return _gpuCache;
}

// ── 模拟 _onGpuReady / _onChainDone 回调 ──
let _onGpuReady = null;
let _onChainDone = null;

// ── 模拟 tick ──
let tickCount = 0;
function tick() {
  tickCount++;
  const t0 = Date.now();
  const gpus = getAllGpus();
  const elapsed = Date.now() - t0;
  const loading = gpus.length === 0 && _gpuState === '';
  const types = gpus.map(g => g.devType || g.type).filter((v, i, a) => a.indexOf(v) === i);
  dbg(`tick #${tickCount}: ${gpus.length} devices [${types.join(',')}], elapsed=${elapsed}ms, cacheAge=${_gpuCacheTime ? Math.round((Date.now() - _gpuCacheTime) / 1000) + 's' : 'none'}${loading ? ' [显示: 加载中…]' : ''}`);
  if (gpus.length > 0) {
    gpus.forEach(g => dbg(`  ${g.devType} ${g.idx}: ${g.name} util=${g.util}% mem=${g.memUsed}/${g.memTotal}MB temp=${g.temp}°C power=${g.power ? g.power.draw + '/' + g.power.limit + 'W' : 'NA'} [${g.type}]`));
  }
}

// ── 运行 ──
console.log(`\n模拟参数: multi-provider (NVIDIA+Ascend), delay=${DELAY}ms, interval=${INTERVAL}ms, TTL=${TTL}ms\n`);
console.log('=== tick 1 (全异步) ===');
tick();
_onGpuReady = () => {
  console.log('\n=== 回调 tick (加速设备数据到达!) ===');
  tick();
};
_onChainDone = () => {
  console.log('\n=== 回调 tick (链完成) ===');
  tick();
};

const timer = setInterval(() => {
  console.log(`\n=== tick ${tickCount + 1} ===`);
  tick();
  if (tickCount >= 6) {
    clearInterval(timer);
    console.log('\n模拟结束。');
    process.exit(0);
  }
}, INTERVAL);
