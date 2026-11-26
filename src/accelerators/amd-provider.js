'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { executionOptions } = require('../core/collection-context');
const { processStartTime } = require('../domain/linux-parsers');
const { incompleteError } = require('../utils/errors');

const AMD_SYSFS_SCRIPT = fs.readFileSync(path.join(__dirname, 'amd-sysfs.sh'), 'utf8');
const SYSFS_FIELDS = 13;
const DEFAULT_NAME = 'AMD Radeon Graphics';
// rocm-smi is the usual ROCm tool, amd-smi replaces it from ROCm 6.1, and older rocm-smi
// releases do not accept --json together with --showpids.
const PROCESS_QUERIES = Object.freeze([
  ['rocm-smi', ['--showpids', '--json']],
  ['amd-smi', ['process', '--json']],
  ['rocm-smi', ['--showpids']],
]);
// Kernels without the product_name sysfs node take the board name from the ROCm tooling when it
// is installed; the result is cached per card for the session.
const PRODUCT_QUERY = Object.freeze(['amd-smi', ['static', '--json']]);
const NAME_JSON_KEYS = /^(?:market|system|product|board)[\s_-]*name$/i;
const BUS_ID_JSON_KEYS = /^(?:bdf|bus[\s_-]*id|pci[\s_-]*slot(?:\s*name)?)$/i;

const UNKNOWN_TEXTS = new Set(['', 'na', 'n/a', 'none', 'null', 'unknown', 'not supported', 'not applicable']);
// Tool output differs across ROCm releases: the process rows are reported as "PID",
// "Process id", or "process_id", optionally followed by the name, a bus id, or a GPU index.
const PID_TEXT_PATTERN = /(?:process\s*id|\bpid)\s*[:=\s]\s*(\d+)/i;
const NAME_TEXT_PATTERN = /(?:process\s*name|\bpname)\s*[:=]\s*([^\t|]+)/i;
const INDEX_TEXT_PATTERN = /(?:gpu|node|device|asic)[\s_-]*(?:id)?\s*[:=\s[]\s*(\d+)/i;
const SECTION_TEXT_PATTERN = /^(?:gpu|node|asic|card)\s*(?:id)?\s*[:[]\s*\d+/i;
const BUS_ID_TEXT_PATTERN = /\b(?:[0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]\b/gi;
const JSON_PID_KEY = /^(?:pid|process[\s_-]*id)$/i;
const JSON_NAME_KEY = /^(?:process[\s_-]*name|pname|name)$/i;
const JSON_MEMORY_KEY = /(?:vram|mem)[\s_-]*used[\s_-]*bytes|used[\s_-]*(?:vram|mem)[\s_-]*(?:bytes)?|process[\s_-]*memory/i;
const JSON_DEVICE_KEY = /^(?:gpu|node|device|asic)(?:[\s_-]*ids?)?$/i;
const JSON_SECTION_KEY = /^(?:gpu|node|asic|card)?\s*(?:\[?\d+\]?|[0-9a-f]{2,4}:[0-9a-f:.]+)$/i;
const BUS_ID_KEY = /\b(?:[0-9a-f]{4}:)?[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]\b/i;

function optionalText(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  return !text || UNKNOWN_TEXTS.has(text.toLowerCase()) ? null : text;
}

function optionalNumber(raw) {
  const text = optionalText(raw);
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function scaledNumber(raw, scale) {
  const value = optionalNumber(raw);
  return value === null ? null : value / scale;
}

// amdgpu reports the hwmon power sensor in microwatts although the documented unit (and other
// drivers) is milliwatts. A milliwatt reading only reaches this size above 100 W, so larger
// values are read as microwatts.
const POWER_MICROWATT_THRESHOLD = 100000;

function optionalWatts(raw) {
  const value = optionalNumber(raw);
  if (value === null || value < 0) return null;
  return value >= POWER_MICROWATT_THRESHOLD ? value / 1e6 : value / 1000;
}

// PCI slot names are reported with and without the domain segment depending on the tool.
function normalizeBusId(raw) {
  const match = String(raw === null || raw === undefined ? '' : raw).match(BUS_ID_KEY);
  if (!match) return null;
  const value = match[0].toLowerCase();
  const parts = value.split(':');
  if (parts.length === 2) return '0000:' + value;
  return parts[0].padStart(4, '0') + ':' + parts.slice(1).join(':');
}

function busIdsOf(text) {
  return [...String(text).matchAll(BUS_ID_TEXT_PATTERN)].map((match) => normalizeBusId(match[0]));
}

// The shell script leaves a field empty for every reading the driver does not expose. A card
// without any metric and without a board identifier is not an observable AMD GPU (older drivers,
// other vendors' DRM cards), so it is dropped instead of shown as an empty card.
function parseAmdSysfsCards(raw) {
  const devices = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    const fields = line.replace(/\r$/, '').split('\t');
    if (fields.length !== SYSFS_FIELDS) throw incompleteError('Incomplete AMD GPU query output');
    const [cardName, rawBusId, busy, vramUsed, vramTotal, temperatureEdge, temperatureJunction, temperatureMemory, power, powerLimit, product, deviceId] = fields.slice(1);
    const busId = normalizeBusId(rawBusId);
    const name = optionalText(product);
    const pciDeviceId = optionalText(deviceId);
    const temperatures = [temperatureEdge, temperatureJunction, temperatureMemory]
      .map((value) => scaledNumber(value, 1000)).filter((value) => value !== null);
    const totalBytes = optionalNumber(vramTotal);
    const usedBytes = optionalNumber(vramUsed);
    const memory = { usedBytes: null, totalBytes: null };
    // APUs report a zero VRAM size; their memory usage stays unknown instead of showing 0.
    if (totalBytes > 0) { memory.totalBytes = totalBytes; memory.usedBytes = usedBytes === null ? null : Math.min(usedBytes, totalBytes); }
    const utilizationPercent = optionalNumber(busy);
    const drawWatts = optionalWatts(power);
    // A limit of 0 is what the driver reports when the board has no power cap.
    const limitWatts = optionalWatts(powerLimit);
    if (utilizationPercent === null && !memory.totalBytes && !temperatures.length && drawWatts === null && !name && !pciDeviceId) continue;
    const stableId = busId || optionalText(cardName) || String(devices.length);
    devices.push({
      provider: 'amd', deviceKey: `amd:${stableId}`, providerDeviceId: stableId, nativeIndex: devices.length,
      busId, cardName: optionalText(cardName) || stableId,
      name: name || (pciDeviceId ? `AMD GPU (${pciDeviceId})` : DEFAULT_NAME),
      productName: name,
      utilizationPercent,
      memory,
      temperatureCelsius: temperatures.length ? Math.round(temperatures[0]) : null,
      power: drawWatts === null ? null : { drawWatts, limitWatts: limitWatts > 0 ? limitWatts : null },
    });
  }
  return devices;
}

// Board names sit in a different section than the PCI address (amd-smi static keeps the name
// under asic and the address under bus), so a subtree is matched as a whole. A subtree covering
// several cards is descended into until one address is left per name.
function collectProductNames(value, collected) {
  if (Array.isArray(value)) { for (const item of value) collectProductNames(item, collected); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const scalar = item === null || typeof item === 'object' ? null : String(item).trim();
    const name = scalar === null ? null : optionalText(scalar);
    if (name && (NAME_JSON_KEYS.test(key) || normalizeBusId(key))) collected.names.push(name);
    else if (scalar !== null && BUS_ID_JSON_KEYS.test(key)) collected.busIds.push(...busIdsOf(scalar));
    else collectProductNames(item, collected);
  }
}

function parseAmdProductNames(raw) {
  const names = new Map();
  const visit = (value) => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== 'object') return;
    const collected = { names: [], busIds: [] };
    collectProductNames(value, collected);
    if (collected.busIds.length === 1 && collected.names.length) {
      if (!names.has(collected.busIds[0])) names.set(collected.busIds[0], collected.names[0]);
      return;
    }
    for (const item of Object.values(value)) visit(item);
  };
  visit(JSON.parse(String(raw || '').trim()));
  return names;
}

// Process hints identify the card either by PCI slot or by the tool's own GPU index.
function hintFromValue(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return { index: value };
  if (Array.isArray(value)) {
    for (const item of value) { const hint = hintFromValue(item); if (hint) return hint; }
    return null;
  }
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return null;
  const busId = normalizeBusId(text);
  if (busId) return { busId };
  if (/^\d+$/.test(text)) return { index: Number(text) };
  const match = text.match(/^(?:gpu|card)?\s*\[?(\d+)\]?$/i);
  return match ? { index: Number(match[1]) } : null;
}

function hintsOf(value) {
  const hints = [];
  if (Array.isArray(value)) { for (const item of value) hints.push(...hintsOf(item)); return hints; }
  const hint = hintFromValue(value);
  return hint ? [hint] : hints;
}

function hintFromKey(key) {
  const text = String(key || '').trim();
  if (!text || !JSON_SECTION_KEY.test(text)) return null;
  const busId = normalizeBusId(text);
  if (busId) return { busId };
  const match = text.match(/\[?(\d+)\]?$/);
  return match ? { index: Number(match[1]) } : null;
}

function addProcessRow(rows, pid, fields, hints) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const row = rows.get(pid) || { name: null, memoryUsedBytes: null, busIds: [], indexes: [] };
  if (fields.name) row.name = fields.name;
  if (Number.isFinite(fields.memoryUsedBytes)) row.memoryUsedBytes = fields.memoryUsedBytes;
  for (const hint of hints) {
    if (hint.busId && !row.busIds.includes(hint.busId)) row.busIds.push(hint.busId);
    if (hint.index !== undefined && !row.indexes.includes(hint.index)) row.indexes.push(hint.index);
  }
  rows.set(pid, row);
}

// rocm-smi prints the KFD process table with its own header ("PID  PROCESS NAME  GPU(s)
// VRAM USED  SDMA USED  CU OCCUPANCY"), so the values are read by column instead of guessed.
const TABLE_COLUMNS = [
  ['pid', /^pid$/i],
  ['name', /(?:process\s*)?name/i],
  ['gpu', /gpu|node|asic|device/i],
  ['memory', /vram|\bmem/i],
];
const MEMORY_UNITS = [[/\bmb\b/i, 1048576], [/\bkb\b/i, 1024]];

function memoryScaleOf(cell) {
  for (const [pattern, scale] of MEMORY_UNITS) if (pattern.test(cell)) return scale;
  return 1;
}

function splitTableCells(text) {
  return (text.includes('\t') ? text.split('\t') : text.split(/\s{2,}/)).map((cell) => cell.trim());
}

function parseProcessTableHeader(text) {
  const cells = splitTableCells(text);
  if (cells.length < 2) return null;
  const columns = { pid: null, name: null, gpu: null, memory: null, memoryScale: 1 };
  cells.forEach((cell, index) => {
    for (const [key, pattern] of TABLE_COLUMNS) {
      if (columns[key] === null && pattern.test(cell)) {
        columns[key] = index;
        if (key === 'memory') columns.memoryScale = memoryScaleOf(cell);
        break;
      }
    }
  });
  return columns.pid === null ? null : columns;
}

function hintsOfCell(text) {
  const hints = [];
  for (const part of String(text).split(/[\s,;]+/)) hints.push(...hintsOf(part));
  return hints;
}

function parseProcessTableRow(text, columns) {
  const cells = splitTableCells(text);
  if (cells.length <= columns.pid || !/^\d+$/.test(cells[columns.pid])) return null;
  const at = (index) => index !== null && index < cells.length ? cells[index] : '';
  const reported = columns.memory !== null ? optionalNumber(at(columns.memory)) : null;
  return {
    pid: Number(cells[columns.pid]),
    fields: {
      name: optionalText(at(columns.name)),
      memoryUsedBytes: reported === null ? null : Math.round(reported * columns.memoryScale),
    },
    hints: hintsOfCell(at(columns.gpu)),
  };
}

// rocm-smi --showpids --json collapses each process into one comma separated value that follows
// the same column order as its text table: name, GPU, VRAM, SDMA, and CU occupancy.
const JSON_KEY_PID = /^p(?:id|rocess)[\s_-]*(\d+)$/i;

function parseProcessValueList(text) {
  const parts = String(text).split(',').map((part) => part.trim());
  if (parts.length < 3) return { fields: { name: optionalText(text), memoryUsedBytes: null }, hints: [] };
  const [name, gpu, memory] = parts;
  const reported = optionalNumber(memory);
  return { fields: { name: optionalText(name), memoryUsedBytes: reported }, hints: hintsOfCell(gpu) };
}

// amd-smi reports one object per GPU ({"gpu": 0, "process_list": [...]}), while rocm-smi keys its
// object by GPU index or card and repeats the association inside the process entry. The GPU of an
// entry is therefore kept for the entries nested below it.
function parseAmdProcessJson(value, sections, rows) {
  if (Array.isArray(value)) { for (const item of value) parseAmdProcessJson(item, sections, rows); return; }
  if (!value || typeof value !== 'object') return;
  const fields = { name: null, memoryUsedBytes: null };
  const hints = [];
  const nested = [];
  let pid = null;
  for (const [key, item] of Object.entries(value)) {
    const scalar = item === null || typeof item === 'object' ? null : String(item).trim();
    const keyed = scalar === null ? null : String(key).match(JSON_KEY_PID);
    if (keyed) {
      // Every process is its own entry in this shape, so it is stored as it is read.
      const listed = parseProcessValueList(scalar);
      addProcessRow(rows, Number(keyed[1]), listed.fields, [...listed.hints, ...sections]);
    } else if (JSON_PID_KEY.test(key) && scalar !== null && /^\d+$/.test(scalar)) pid = Number(scalar);
    else if (JSON_NAME_KEY.test(key) && scalar !== null) fields.name = optionalText(scalar);
    else if (JSON_MEMORY_KEY.test(key) && scalar !== null && Number.isFinite(Number(scalar))) fields.memoryUsedBytes = Number(scalar);
    else if (JSON_DEVICE_KEY.test(key)) hints.push(...hintsOf(item));
    else nested.push([key, item]);
  }
  const inherited = [...hints, ...sections];
  if (pid !== null) addProcessRow(rows, pid, fields, inherited);
  for (const [key, item] of nested) {
    const section = hintFromKey(key);
    parseAmdProcessJson(item, section ? [section, ...inherited] : inherited, rows);
  }
}

function parseAmdProcessText(raw, rows) {
  const sections = [];
  let lastPid = null;
  let table = null;
  for (const line of String(raw || '').split('\n')) {
    const text = line.trim();
    if (!text || /^[-+=| ]+$/.test(text)) { table = null; continue; }
    if (table) {
      const row = parseProcessTableRow(text, table);
      if (row) { addProcessRow(rows, row.pid, row.fields, [...row.hints, ...sections]); lastPid = row.pid; continue; }
      table = null;
    }
    const header = parseProcessTableHeader(text);
    if (header) { table = header; continue; }
    const pidMatch = text.match(PID_TEXT_PATTERN);
    if (!pidMatch && SECTION_TEXT_PATTERN.test(text)) {
      const hint = hintFromValue(text.match(/\d+/)[0]);
      if (hint) sections.unshift(hint);
      continue;
    }
    let pid = pidMatch ? Number(pidMatch[1]) : null;
    // Association lines ("Process run on GPU ID: 0") repeat no PID, so they belong to the
    // previous process row; a bare table row ("| 0 | 1234 | python |") carries its own cells.
    if (pid === null && lastPid !== null && /gpu|node|asic|device|name/i.test(text)) pid = lastPid;
    if (pid === null) {
      const cells = (text.includes('|') ? text.split('|') : text.split(/\s{2,}/)).map((cell) => cell.trim()).filter(Boolean);
      const numericCell = cells.find((cell) => /^[1-9]\d*$/.test(cell));
      if (numericCell !== undefined) pid = Number(numericCell);
    }
    if (!Number.isInteger(pid) || pid <= 0) continue;
    lastPid = pid;
    const fields = { name: null, memoryUsedBytes: null };
    const nameMatch = text.match(NAME_TEXT_PATTERN);
    if (nameMatch) fields.name = optionalText(nameMatch[1]);
    const hints = busIdsOf(text).map((busId) => ({ busId }));
    const indexMatch = text.match(INDEX_TEXT_PATTERN);
    if (indexMatch) hints.push({ index: Number(indexMatch[1]) });
    addProcessRow(rows, pid, fields, [...hints, ...sections]);
  }
}

// ROCm tools report the occupying processes either as a JSON tree keyed by GPU index or card, or
// as a text table where the process name and the GPU association may be split across lines.
function parseAmdProcesses(raw, devices) {
  const rows = new Map();
  const text = String(raw || '').trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try { parseAmdProcessJson(JSON.parse(text), [], rows); } catch (error) { parseAmdProcessText(text, rows); }
  } else {
    parseAmdProcessText(text, rows);
  }
  return amdUsagesByPid(rows, devices);
}

function amdUsagesByPid(rows, devices) {
  const devicesByBusId = new Map(devices.filter((device) => device.busId).map((device) => [device.busId, device]));
  const devicesByIndex = new Map(devices.map((device) => [device.nativeIndex, device]));
  const usagesByPid = new Map();
  for (const [pid, row] of rows) {
    const device = row.busIds.map((busId) => devicesByBusId.get(busId)).find(Boolean)
      || row.indexes.map((index) => devicesByIndex.get(index)).find(Boolean) || null;
    const reported = row.busIds[0] || (row.indexes.length ? String(row.indexes[0]) : null);
    const usage = {
      pid,
      deviceKey: device ? device.deviceKey : null,
      nativeIndex: device ? device.nativeIndex : null,
      providerDeviceId: device ? device.providerDeviceId : reported,
      // rocm-smi reports per-process VRAM; a listing without it leaves the usage unknown, not 0.
      memoryUsedBytes: row.memoryUsedBytes === null ? null : row.memoryUsedBytes,
      memoryTotalBytes: device ? device.memory.totalBytes : null,
      mappingStatus: device ? 'matched' : 'unmatched',
    };
    if (!usagesByPid.has(pid)) usagesByPid.set(pid, []);
    usagesByPid.get(pid).push(usage);
  }
  return usagesByPid;
}

class AmdProvider {
  constructor({ commandRunner, userId = typeof process.getuid === 'function' ? process.getuid() : null, systemInfo = null }) {
    Object.assign(this, { commandRunner, userId, systemInfo });
    this.id = 'amd';
    this.productNames = new Map();
  }

  // Older kernels leave product_name empty, so the board name is taken from the ROCm tooling
  // once per card. A card without a usable name keeps the PCI identifier from sysfs.
  async readProductNames(devices) {
    const missing = devices.filter((device) => !device.productName && !this.productNames.has(device.providerDeviceId));
    let names = new Map();
    if (missing.length) {
      try {
        const { stdout } = await this.commandRunner.execFile(PRODUCT_QUERY[0], PRODUCT_QUERY[1], executionOptions({ timeoutMilliseconds: 5000 }));
        names = parseAmdProductNames(stdout);
      } catch (error) {
        if (error.code === 'ETIMEDOUT' || error.code === 'ABORT_ERR') throw error;
      }
      for (const device of missing) this.productNames.set(device.providerDeviceId, (device.busId && names.get(device.busId)) || null);
    }
    for (const device of devices) {
      if (device.productName) continue;
      const name = this.productNames.get(device.providerDeviceId);
      if (name) device.name = name;
    }
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
      if (!match) throw incompleteError('Incomplete AMD GPU process identity output');
      const startedAt = processStartTime(match[4]);
      if (!Number.isFinite(startedAt)) throw incompleteError('Incomplete AMD GPU process start time');
      const pid = Number(match[1]);
      identities.set(pid, { processKey: pid + ':' + startedAt, userId: Number(match[2]), userName: match[3] });
    }
    return identities;
  }

  async readProcessTable() {
    let failure = null;
    for (const [command, args] of PROCESS_QUERIES) {
      try {
        const { stdout } = await this.commandRunner.execFile(command, args, executionOptions({ timeoutMilliseconds: 10000 }));
        if (stdout && stdout.trim()) return stdout;
      } catch (error) {
        if (error.code === 'ETIMEDOUT' || error.code === 'ABORT_ERR') throw error;
        failure = error;
      }
    }
    if (failure) throw failure;
    return '';
  }

  async collect({ onPartial = () => {} } = {}) {
    const { stdout } = await this.commandRunner.execFile('sh', ['-c', AMD_SYSFS_SCRIPT, 'sysmonitor-amd'], executionOptions({ timeoutMilliseconds: 10000 }));
    const devices = parseAmdSysfsCards(stdout);
    const cards = { devices, usagesByPid: new Map(), currentUserDeviceKeys: [], occupancyKnown: false, sampledAt: Date.now() };
    if (!devices.length) return { ...cards, occupancyKnown: true };
    await this.readProductNames(devices);
    onPartial({ value: cards, failureCode: 'GPU_OCCUPANCY_UNAVAILABLE' });
    let processOutput;
    try {
      processOutput = await this.readProcessTable();
    } catch (error) {
      // The amdgpu driver exposes no per-process list, so without the ROCm tools the card
      // metrics stay visible while the idle state stays unknown.
      return { ...cards, collectionErrors: [{ code: 'GPU_OCCUPANCY_UNAVAILABLE', message: error.message }] };
    }
    const usagesByPid = parseAmdProcesses(processOutput, devices);
    for (const usages of usagesByPid.values()) for (const usage of usages) usage.identityKnown = false;
    const occupied = { ...cards, usagesByPid, occupancyKnown: true };
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

module.exports = { AmdProvider, parseAmdSysfsCards, parseAmdProcesses, AMD_SYSFS_SCRIPT };
