'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { AmdProvider, parseAmdSysfsCards, parseAmdProcesses } = require('../src/accelerators/amd-provider');
const { AcceleratorCollector } = require('../src/collectors/accelerator-collector');
const { CollectorRunner } = require('../src/core/collector-runner');
const { SnapshotStore } = require('../src/core/snapshot-store');
const { NvidiaProvider } = require('../src/accelerators/nvidia-provider');

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
// sysfs fields follow the order of amd-sysfs.sh: index, card, slot, busy, vram used, vram total,
// edge, junction, memory, power, power limit, product name, PCI device id.
const card = (...fields) => fields.join('\t');
const row = (cells) => cells.join('\t');

const SYSFS_CARDS = [
  card('1', 'card1', '0000:03:00.0', '37', '8589934592', '17179869184', '45000', '52000', '49000', '197000000', '355000000', 'AMD Radeon RX 7900 XTX', '0x744c'),
  card('2', 'card2', '0000:0c:00.0', '8', '0', '0', '', '', '', '', '', '', '0x1636'),
  card('3', 'card3', '0000:0d:00.0', '', '', '', '', '', '', '', '', '', ''),
].join('\n') + '\n';

const KFD_TABLE = [
  '',
  '========================= ROCm System Management Interface =========================',
  '================================== KFD Processes ===================================',
  'KFD process information:',
  row(['PID', 'PROCESS NAME', 'GPU(s)', 'VRAM USED', 'SDMA USED', 'CU OCCUPANCY']),
  row(['2201', 'python3', '0', '2147483648', '0', '0']),
  row(['2202', 'UNKNOWN', '0000:0c:00.0', '536870912', '0', '0']),
  '====================================================================================',
  '=============================== End of ROCm SMI Log ================================',
].join('\n');

const ROCM_PIDS_JSON = '{"system": {"PID2201": "python3, 0, 2147483648, 0, 0", "PID2202": "training, 1, 536870912, 0, 0"}}';
const ROCM_PIDS_OLDER = [
  '========================= ROCm System Management Interface =========================',
  'GPU[0]\t\t: PID: 2201  Process name: python3',
  'GPU[0]\t\t: Process run on GPU ID: 0000:03:00.0',
  'GPU[1]\t\t: PID: 2202  Process name: training',
  '====================================================================================',
].join('\n');
const AMD_SMI_PROCESSES = JSON.stringify([
  { gpu: 0, process_list: [{ process_id: 2201, process_name: 'python3' }] },
  { gpu: 1, process_list: [{ process_id: 2202, process_name: 'training' }] },
]);
const AMD_SMI_STATIC = JSON.stringify({
  gpu_data: [
    { gpu: 0, asic: { market_name: 'AMD Radeon Pro VII', device_id: '0x66a1' }, bus: { bdf: '0000:03:00.0' } },
    { gpu: 1, asic: { market_name: 'AMD Radeon RX 6600', device_id: '0x73ff' }, bus: { bdf: '0000:0c:00.0' } },
  ],
});

function amdRunner(responses) {
  return {
    calls: [],
    async execFile(command, args = []) {
      this.calls.push([command, ...args].join(' '));
      if (command === 'sh') assert.ok(String(args[1]).includes('/sys/class/drm'), 'the sysfs query reads the DRM sysfs tree');
      const response = responses[command];
      if (response === undefined) throw Object.assign(new Error('command not found: ' + command), { code: 'ENOENT' });
      if (response instanceof Error) throw response;
      return { stdout: typeof response === 'function' ? response(args) : response };
    },
  };
}

const amdProvider = (responses, options = {}) => new AmdProvider({ userId: 1000, commandRunner: amdRunner(responses), ...options });

test('AMD sysfs parsing converts temperature and power units and keys cards by PCI slot', () => {
  const devices = parseAmdSysfsCards(SYSFS_CARDS);
  assert.deepEqual(devices.map((device) => device.provider), ['amd', 'amd']);
  assert.deepEqual(devices.map((device) => device.deviceKey), ['amd:0000:03:00.0', 'amd:0000:0c:00.0']);
  assert.deepEqual(devices.map((device) => device.nativeIndex), [0, 1]);
  const [discrete, apu] = devices;
  assert.equal(discrete.name, 'AMD Radeon RX 7900 XTX');
  assert.equal(discrete.utilizationPercent, 37);
  assert.deepEqual(discrete.memory, { usedBytes: 8 * GIB, totalBytes: 16 * GIB });
  assert.equal(discrete.temperatureCelsius, 45);
  assert.deepEqual(discrete.power, { drawWatts: 197, limitWatts: 355 });
  // An APU reports a zero VRAM size and no board name, so both stay unknown instead of zero.
  assert.equal(apu.name, 'AMD GPU (0x1636)');
  assert.deepEqual(apu.memory, { usedBytes: null, totalBytes: null });
  assert.equal(apu.power, null);
});

test('AMD parsing drops a card without any reading and rejects a truncated query', () => {
  assert.equal(parseAmdSysfsCards(SYSFS_CARDS).length, 2);
  assert.throws(() => parseAmdSysfsCards(card('1', 'card1', '0000:03:00.0', '37')), (error) => error.code === 'EINCOMPLETE');
});

test('the sysfs query only reports AMD DRM cards and skips other vendors', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmonitor-amd-'));
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), value);
  };
  write('card0/device/vendor', '0x8086\n');
  write('card0/device/gpu_busy_percent', '11\n');
  write('card1/device/vendor', '0x1002\n');
  write('card1/device/uevent', 'DRIVER=amdgpu\nPCI_ID=1002:73bf\nPCI_SLOT_NAME=0000:05:00.0\n');
  write('card1/device/gpu_busy_percent', '42\n');
  write('card1/device/mem_info_vram_used', '1073741824\n');
  write('card1/device/mem_info_vram_total', '8589934592\n');
  write('card1/device/hwmon/hwmon3/temp1_input', '56000\n');
  write('card1/device/hwmon/hwmon3/power1_input', '110000000\n');
  write('card1-DP-1/status', 'connected\n');
  write('renderD128/dev', '226:128\n');
  try {
    const stdout = execFileSync('sh', [path.join(__dirname, '..', 'src', 'accelerators', 'amd-sysfs.sh')], { env: { ...process.env, SYSMON_DRM_ROOT: root } }).toString();
    const devices = parseAmdSysfsCards(stdout);
    assert.deepEqual(devices.map((device) => device.cardName), ['card1']);
    assert.equal(devices[0].busId, '0000:05:00.0');
    assert.equal(devices[0].utilizationPercent, 42);
    assert.deepEqual(devices[0].memory, { usedBytes: 1073741824, totalBytes: 8589934592 });
    assert.equal(devices[0].temperatureCelsius, 56);
    assert.deepEqual(devices[0].power, { drawWatts: 110, limitWatts: null });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AMD KFD process tables map onto cards by index or PCI slot and keep reported VRAM', () => {
  const devices = parseAmdSysfsCards(SYSFS_CARDS);
  const usagesByPid = parseAmdProcesses(KFD_TABLE, devices);
  assert.deepEqual([...usagesByPid.keys()], [2201, 2202]);
  const [first] = usagesByPid.get(2201);
  assert.equal(first.deviceKey, 'amd:0000:03:00.0');
  assert.equal(first.nativeIndex, 0);
  assert.equal(first.memoryUsedBytes, 2 * GIB);
  assert.equal(first.memoryTotalBytes, 16 * GIB);
  assert.equal(first.mappingStatus, 'matched');
  const [second] = usagesByPid.get(2202);
  assert.equal(second.deviceKey, 'amd:0000:0c:00.0');
  assert.equal(second.memoryUsedBytes, 512 * MIB);
});

test('AMD process listings from the rocm-smi and amd-smi JSON formats map onto the same cards', () => {
  const devices = parseAmdSysfsCards(SYSFS_CARDS);
  const rocm = parseAmdProcesses(ROCM_PIDS_JSON, devices);
  assert.deepEqual([...rocm.keys()], [2201, 2202]);
  assert.equal(rocm.get(2201)[0].deviceKey, 'amd:0000:03:00.0');
  assert.equal(rocm.get(2201)[0].memoryUsedBytes, 2 * GIB);
  assert.equal(rocm.get(2202)[0].deviceKey, 'amd:0000:0c:00.0');
  const amdSmi = parseAmdProcesses(AMD_SMI_PROCESSES, devices);
  assert.equal(amdSmi.get(2201)[0].deviceKey, 'amd:0000:03:00.0');
  assert.equal(amdSmi.get(2201)[0].mappingStatus, 'matched');
  assert.equal(amdSmi.get(2202)[0].deviceKey, 'amd:0000:0c:00.0');
  // Tools without per-process memory leave the usage unknown instead of reporting zero.
  assert.equal(amdSmi.get(2202)[0].memoryUsedBytes, null);
});

test('older rocm-smi output associates a process with its card across lines', () => {
  const devices = parseAmdSysfsCards(SYSFS_CARDS);
  const usagesByPid = parseAmdProcesses(ROCM_PIDS_OLDER, devices);
  const [first] = usagesByPid.get(2201);
  assert.equal(first.deviceKey, 'amd:0000:03:00.0');
  assert.equal(first.mappingStatus, 'matched');
  assert.equal(usagesByPid.get(2202)[0].deviceKey, 'amd:0000:0c:00.0');
});

test('AMD collect resolves process owners, marks current user cards, and names cards from amd-smi', async () => {
  const provider = amdProvider({
    sh: SYSFS_CARDS.replace('AMD Radeon RX 7900 XTX', '').replace('0x1636', ''),
    'rocm-smi': ROCM_PIDS_JSON,
    'amd-smi': AMD_SMI_STATIC,
    ps: () => '2201 1000 train Thu Nov 20 10:00:00 2025\n2202 1000 worker Thu Nov 20 10:00:00 2025\n',
  });
  const value = await provider.collect();
  assert.deepEqual(value.devices.map((device) => device.name), ['AMD Radeon Pro VII', 'AMD Radeon RX 6600']);
  assert.equal(value.occupancyKnown, true);
  const [usage] = value.usagesByPid.get(2201);
  assert.equal(usage.userName, 'train');
  assert.equal(usage.identityKnown, true);
  assert.deepEqual(value.currentUserDeviceKeys, ['amd:0000:03:00.0', 'amd:0000:0c:00.0']);
  // The board name never changes, so the second collection reuses the cached value.
  const again = await provider.collect();
  assert.deepEqual(again.devices.map((device) => device.name), ['AMD Radeon Pro VII', 'AMD Radeon RX 6600']);
  assert.equal(provider.commandRunner.calls.filter((call) => call.startsWith('amd-smi')).length, 1);
});

test('AMD collect keeps card metrics and reports an unknown idle state without the ROCm tools', async () => {
  const provider = amdProvider({ sh: SYSFS_CARDS });
  const value = await provider.collect();
  assert.deepEqual(value.devices.map((device) => device.utilizationPercent), [37, 8]);
  assert.equal(value.devices[0].name, 'AMD Radeon RX 7900 XTX');
  assert.equal(value.occupancyKnown, false);
  assert.equal(value.collectionErrors[0].code, 'GPU_OCCUPANCY_UNAVAILABLE');
});

test('AMD collect keeps occupancy unknown when only the ownership query fails', async () => {
  const provider = amdProvider({
    sh: SYSFS_CARDS,
    'rocm-smi': ROCM_PIDS_JSON,
    ps: Object.assign(new Error('ps failed'), { exitCode: 3, stderr: 'ps: not supported' }),
  });
  const value = await provider.collect();
  assert.equal(value.occupancyKnown, true);
  assert.equal(value.usagesByPid.get(2201)[0].identityKnown, false);
  assert.deepEqual(value.currentUserDeviceKeys, []);
  assert.equal(value.collectionErrors[0].code, 'GPU_IDENTITY_UNAVAILABLE');
});

test('a host without AMD DRM cards reports no AMD devices and no failure', async () => {
  const provider = amdProvider({ sh: '' });
  const value = await provider.collect();
  assert.deepEqual(value.devices, []);
  assert.equal(value.occupancyKnown, true);
  assert.equal(value.collectionErrors, undefined);
});

test('the accelerator collector combines NVIDIA and AMD devices and skips a missing tool', async () => {
  const nvidia = new NvidiaProvider({ userId: 1000, commandRunner: amdRunner({
    'nvidia-smi': Object.assign(new Error('command not found'), { code: 'ENOENT' }),
  }) });
  const amd = amdProvider({ sh: SYSFS_CARDS, 'rocm-smi': '{"system": {}}' });
  const store = new SnapshotStore();
  const runner = new CollectorRunner({ key: 'accelerators', collector: new AcceleratorCollector({ providers: [nvidia, amd] }), snapshotStore: store, timeoutMilliseconds: 1000 });
  await runner.run();
  await runner.idle;
  const snapshot = store.read();
  assert.equal(snapshot.accelerators.lastError, null);
  assert.deepEqual(snapshot.accelerators.value.devices.map((device) => device.deviceKey), ['amd:0000:03:00.0', 'amd:0000:0c:00.0']);
  assert.equal(snapshot.accelerators.value.occupancyKnown, true);
});

test('the accelerator collector keeps NVIDIA and AMD results side by side', async () => {
  const nvidia = new NvidiaProvider({ userId: 1000, commandRunner: amdRunner({
    'nvidia-smi': (args) => args[0].startsWith('--query-gpu=')
      ? '0, NVIDIA GeForce RTX 3080, 45, 2048, 10240, 65, 120.5, 320.0, GPU-abc-123\n'
      : '',
  }) });
  const amd = amdProvider({ sh: SYSFS_CARDS, 'rocm-smi': KFD_TABLE });
  const store = new SnapshotStore();
  const runner = new CollectorRunner({ key: 'accelerators', collector: new AcceleratorCollector({ providers: [nvidia, amd] }), snapshotStore: store, timeoutMilliseconds: 1000 });
  await runner.run();
  await runner.idle;
  const value = store.read().accelerators.value;
  assert.deepEqual(value.devices.map((device) => device.deviceKey), ['nvidia:GPU-abc-123', 'amd:0000:03:00.0', 'amd:0000:0c:00.0']);
  assert.equal(value.usagesByPid.get(2201)[0].deviceKey, 'amd:0000:03:00.0');
});
