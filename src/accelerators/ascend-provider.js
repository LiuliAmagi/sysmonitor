'use strict';
const { executionOptions } = require('../core/collection-context');
const { processStartTime } = require('../domain/linux-parsers');

const MEBIBYTE = 1024 * 1024;

// Known per-chip power limits (W), same table as nputop (ascend-nputop).
// npu-smi does not expose a power limit, so these are model-based values.
const POWER_LIMITS_WATTS = {
  '310P1': 90, '310P3': 72,
  '910A': 310, '910B': 265, '910B1': 430, '910B2': 420, '910B3': 350, '910B4': 310, '910C': 350,
};

function optionalInteger(raw) {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

function mebibytesToBytes(raw) {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value * MEBIBYTE : null;
}

function parsePair(raw) {
  const [used, total] = String(raw || '').split('/').map((part) => part.trim());
  return { usedBytes: mebibytesToBytes(used), totalBytes: mebibytesToBytes(total) };
}

function parseWatts(raw) {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

// npu-smi tables have three major columns; fields inside a column are separated by wide spaces.
function splitColumns(cell) {
  return cell.replace(/\s*\/\s*/g, '/').split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
}

function applyPowerLimit(card) {
  const lastToken = String(card.name || '').split(/\s+/).pop();
  const limit = POWER_LIMITS_WATTS[card.name] !== undefined ? POWER_LIMITS_WATTS[card.name] : POWER_LIMITS_WATTS[lastToken];
  card.powerLimitWatts = limit !== undefined ? limit : null;
}

// Parse `npu-smi info` output. Device tables come in two layouts: a device line
// ("NPU_ID Name") followed by a chip line ("CHIP_ID [DEVICE_ID]"), and per-device
// key-value sections (`npu-smi info -i N`). Models such as Atlas 310P with
// npu-smi 24.x report physical card IDs (e.g. 1536) instead of 0-based device IDs,
// and several chips can share one card ID, so cards are renumbered to sequential
// IDs whenever the reported IDs are not already 0..n-1 (the runtime exposes
// devices as davinci0..N-1).
function parseNpuSmiCards(raw) {
  const cards = [];
  let cur = null;
  let inDeviceSection = false;
  const startCard = (reportedIndex, name) => {
    if (cur) cards.push(cur);
    cur = { reportedIndex, chipId: 0, name: name || 'Ascend', utilizationPercent: null,
      memory: { usedBytes: null, totalBytes: null }, temperatureCelsius: null,
      drawWatts: null, powerLimitWatts: null };
  };
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (t.startsWith('|') && /NPU\b.*\bName/.test(t) && /Power|Temp/.test(t)) { inDeviceSection = true; continue; }
    if (t.startsWith('|') && /Process\s+id/i.test(t)) { inDeviceSection = false; continue; }
    if (t.startsWith('|') && inDeviceSection && !t.includes('---') && !t.includes('===') && !t.includes('npu-smi')) {
      const cells = t.split('|').map((part) => part.trim()).filter(Boolean);
      if (cells.length >= 1 && /^\d/.test(cells[0])) {
        const c1 = cells[0] || '';
        const c3 = cells[2] || '';
        // Chip line: the first cell contains only digits, optionally "CHIP_ID DEVICE_ID".
        const isChipLine = /^\d+(\s+\d+)?$/.test(c1);
        if (!isChipLine) {
          const c1Parts = c1.split(/\s{2,}/);
          if (c1Parts.length >= 2 && /^\d+$/.test(c1Parts[0])) {
            // Device line: [NPU_ID, Name], [Health], [Power, Temp, Hugepages-or-Memory]
            startCard(Number(c1Parts[0]), c1Parts.slice(1).join(' ').trim());
            const fields = splitColumns(c3);
            cur.drawWatts = parseWatts(fields[0]);
            cur.temperatureCelsius = optionalInteger(fields[1]);
            if (fields[2]) cur.memory = parsePair(fields[2]);
          }
        } else if (cur) {
          // Chip line: [CHIP_ID (DEVICE_ID)], [Bus_ID], [AICore%, Memory_Used/Memory_Total, (HBM_Used/HBM_Total)]
          cur.chipId = optionalInteger(c1.split(/\s+/)[0]) || 0;
          const fields = splitColumns(c3);
          const aiCore = optionalInteger(fields[0]);
          if (aiCore !== null) cur.utilizationPercent = aiCore;
          const memory = parsePair(fields[1]);
          if (memory.totalBytes) cur.memory = memory;
          const hbm = parsePair(fields[2]);
          if (hbm.totalBytes) cur.memory = hbm;
        }
      }
    }
    // Key-value format (`npu-smi info -i N`).
    const kvMatch = line.match(/^\s*(.+?):\s+(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();
      if (key === 'NPU ID') startCard(optionalInteger(value), null);
      if (!cur) continue;
      if (key === 'NPU Name' || key === 'Product Name') cur.name = value;
      if (key === 'AI Core(%)' || key === 'AICore(%)') cur.utilizationPercent = optionalInteger(value);
      if (key === 'Temperature(C)' || key === 'Temp(C)') cur.temperatureCelsius = optionalInteger(value);
      if (key === 'Power(W)' || key === 'Power') cur.drawWatts = parseWatts(value);
      if (key.includes('HBM-Usage') || key.includes('Memory-Usage')) {
        const memory = parsePair(value);
        if (memory.totalBytes) cur.memory = memory;
      }
    }
  }
  if (cur) cards.push(cur);
  const needsRenumbering = cards.some((card, index) => card.reportedIndex !== index);
  cards.forEach((card, index) => { card.nativeIndex = needsRenumbering ? index : card.reportedIndex; });
  cards.forEach(applyPowerLimit);
  return cards;
}

// Boards such as Atlas 310P report Power(W)=NA in the summary table but still expose
// real-time power via `npu-smi info -t power -i <card>` (same approach as nputop).
// Query each affected card once (covering all its chips) and fill in the values.
async function readRealtimePower(commandRunner, cards) {
  const cardsMissingPower = new Map();
  for (const card of cards) {
    if (card.drawWatts === null) {
      if (!cardsMissingPower.has(card.reportedIndex)) cardsMissingPower.set(card.reportedIndex, []);
      cardsMissingPower.get(card.reportedIndex).push(card);
    }
  }
  for (const [reportedIndex, group] of cardsMissingPower) {
    let stdout;
    try {
      ({ stdout } = await commandRunner.execFile('npu-smi', ['info', '-t', 'power', '-i', String(reportedIndex)], executionOptions({ timeoutMilliseconds: 5000 })));
    } catch (error) {
      continue;
    }
    const powers = [...String(stdout).matchAll(/NPU Real-time Power\(W\)\s*:\s*([\d.]+)/g)].map((match) => parseWatts(match[1]));
    const chips = [...String(stdout).matchAll(/Chip ID\s*:\s*(\d+)/g)].map((match) => Number(match[1]));
    for (let index = 0; index < powers.length; index++) {
      const card = (chips.length === powers.length && group.find((item) => item.chipId === chips[index])) || group[index];
      if (card && powers[index] !== null) card.drawWatts = powers[index];
    }
  }
}

// Parse `npu-smi info -t proc` output. NPU markers ("NPU ID : n",
// "No running processes found in NPU 1536", ...) set the current card, and process
// rows are either table cells ("| CARD CHIP | PID | NAME | MEMORY |") or bare
// "PID NAME" lines. Memory is not reported by every npu-smi version, so a missing
// or NA value stays unknown.
function parseNpuSmiProcesses(raw, cards) {
  const cardByKey = new Map();
  const firstCardByReportedIndex = new Map();
  for (const card of cards) {
    cardByKey.set(`cc:${card.reportedIndex}:${card.chipId}`, card);
    if (!firstCardByReportedIndex.has(card.reportedIndex)) firstCardByReportedIndex.set(card.reportedIndex, card);
  }
  const findCard = (reportedIndex, chipId) => {
    if (chipId !== null && chipId !== undefined) {
      const exact = cardByKey.get(`cc:${reportedIndex}:${chipId}`);
      if (exact) return exact;
    }
    return firstCardByReportedIndex.get(reportedIndex) || null;
  };
  const usagesByPid = new Map();
  let current = null;
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const marker = t.match(/NPU\s*(?:ID)?\s*[:\s]\s*(\d+)/i);
    if (marker) { current = { reportedIndex: Number(marker[1]), chipId: null }; continue; }
    const chipMarker = t.match(/Chip\s+ID\s*[:\s]\s*(\d+)/i);
    if (chipMarker && current) { current.chipId = Number(chipMarker[1]); continue; }
    if (/Process\s+id/i.test(t) && !/Process\s+id\s*[:\s]\s*\d/i.test(t)) { current = null; continue; }
    let pid = null;
    let reportedIndex = null;
    let chipId = null;
    let memoryRaw = null;
    const kvPid = t.match(/Process\s+id\s*[:\s]\s*(\d+)/i);
    if (kvPid) pid = Number(kvPid[1]);
    if (!pid && t.startsWith('|')) {
      const cells = t.split('|').map((part) => part.trim()).filter(Boolean);
      const rowMatch = cells.length >= 2 && /^\d+(?:\s+\d+)?$/.test(cells[0]) && /^\d+$/.test(cells[1]);
      if (rowMatch) {
        const [first, second] = cells[0].split(/\s+/).map(Number);
        reportedIndex = first;
        chipId = Number.isFinite(second) ? second : null;
        pid = Number(cells[1]);
        if (cells.length >= 4) memoryRaw = cells[3];
      }
    }
    if (!pid) {
      const bare = t.match(/^(\d+)\s+(\S.*)$/);
      if (bare) pid = Number(bare[1]);
    }
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (reportedIndex === null && current) { reportedIndex = current.reportedIndex; chipId = current.chipId; }
    const card = reportedIndex === null ? null : findCard(reportedIndex, chipId);
    const memory = mebibytesToBytes(memoryRaw);
    const usage = {
      pid,
      deviceKey: card ? `ascend:${card.nativeIndex}` : null,
      nativeIndex: card ? card.nativeIndex : null,
      providerDeviceId: card ? String(card.nativeIndex) : null,
      memoryUsedBytes: memory,
      memoryTotalBytes: card ? card.memory.totalBytes : null,
      mappingStatus: card ? 'matched' : 'unmatched',
    };
    if (!usagesByPid.has(pid)) usagesByPid.set(pid, []);
    usagesByPid.get(pid).push(usage);
  }
  return usagesByPid;
}

class AscendProvider {
  constructor({ commandRunner, userId = typeof process.getuid === 'function' ? process.getuid() : null, systemInfo = null }) {
    Object.assign(this, { commandRunner, userId, systemInfo });
    this.id = 'ascend';
  }

  async readProcessIdentities(pids) {
    let stdout;
    try {
      ({ stdout } = await this.commandRunner.execFile('ps', ['-p', pids.join(','), '-o', 'pid=,uid=,user:32=,lstart='], executionOptions()));
    } catch (error) {
      if ((error.exitCode === 1 || error.code === 1) && !error.stderr?.trim()) return new Map();
      throw error;
    }
    const identities = new Map();
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) throw new Error('Incomplete NPU process identity output');
      const startedAt = processStartTime(match[4]);
      if (!Number.isFinite(startedAt)) throw new Error('Incomplete NPU process start time');
      const pid = Number(match[1]);
      identities.set(pid, { processKey: pid + ':' + startedAt, userId: Number(match[2]), userName: match[3] });
    }
    return identities;
  }

  async collect({ onPartial = () => {} } = {}) {
    const { stdout } = await this.commandRunner.execFile('npu-smi', ['info'], executionOptions({ timeoutMilliseconds: 15000 }));
    const cards = parseNpuSmiCards(stdout);
    if (cards.some((card) => card.drawWatts === null)) await readRealtimePower(this.commandRunner, cards);
    const devices = cards.map((card) => ({
      provider: 'ascend', deviceKey: `ascend:${card.nativeIndex}`, providerDeviceId: String(card.nativeIndex),
      nativeIndex: card.nativeIndex, name: card.name,
      utilizationPercent: card.utilizationPercent,
      memory: { ...card.memory },
      temperatureCelsius: card.temperatureCelsius,
      power: card.drawWatts === null ? null
        : { drawWatts: card.drawWatts, limitWatts: card.powerLimitWatts },
    }));
    const sampled = { devices, usagesByPid: new Map(), currentUserDeviceKeys: [], occupancyKnown: false, sampledAt: Date.now() };
    if (!devices.length) return { ...sampled, occupancyKnown: true };
    onPartial({ value: sampled, failureCode: 'GPU_OCCUPANCY_UNAVAILABLE' });
    let usagesByPid;
    try {
      const { stdout: processOutput } = await this.commandRunner.execFile('npu-smi', ['info', '-t', 'proc'], executionOptions({ timeoutMilliseconds: 10000 }));
      usagesByPid = parseNpuSmiProcesses(processOutput, cards);
    } catch (error) {
      return { ...sampled, collectionErrors: [{ code: 'GPU_OCCUPANCY_UNAVAILABLE', message: error.message }] };
    }
    for (const usages of usagesByPid.values()) for (const usage of usages) usage.identityKnown = false;
    const occupied = { ...sampled, usagesByPid, occupancyKnown: true };
    if (!usagesByPid.size) return occupied;
    onPartial({ value: occupied, failureCode: 'GPU_IDENTITY_UNAVAILABLE' });
    try {
      const identityResults = await Promise.allSettled([
        this.readProcessIdentities([...usagesByPid.keys()]),
        this.systemInfo ? this.systemInfo.userId() : this.userId,
      ]);
      const failure = identityResults.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      const [identities, userId] = identityResults.map((result) => result.value);
      const currentUserDeviceKeys = new Set();
      const identifiedUsages = new Map();
      for (const [pid, usages] of usagesByPid) {
        const identity = identities.get(pid);
        identifiedUsages.set(pid, usages.map((usage) => {
          if (identity && identity.userId === userId && usage.deviceKey) currentUserDeviceKeys.add(usage.deviceKey);
          return { ...usage, identityKnown: !!identity, processKey: identity?.processKey || null, userName: identity?.userName || null };
        }));
      }
      return { ...occupied, usagesByPid: identifiedUsages, currentUserDeviceKeys: [...currentUserDeviceKeys] };
    } catch (error) {
      return { ...occupied, collectionErrors: [{ code: 'GPU_IDENTITY_UNAVAILABLE', message: error.message }] };
    }
  }
}

module.exports = { AscendProvider, parseNpuSmiCards, parseNpuSmiProcesses, POWER_LIMITS_WATTS };
