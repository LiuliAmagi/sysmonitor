'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { AscendProvider, parseNpuSmiCards, parseNpuSmiProcesses } = require('../src/accelerators/ascend-provider');
const { AcceleratorCollector } = require('../src/collectors/accelerator-collector');
const { CollectorRunner } = require('../src/core/collector-runner');
const { SnapshotStore } = require('../src/core/snapshot-store');

const MIB = 1024 * 1024;

// 910B, npu-smi 23.x: the chip line has a single chip id and a memory column.
const NPU_INFO_910B = `+-----------------------------------------------------------------------------------+
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

// Atlas 310P, npu-smi 24.1.rc4.b999: the physical card id 1536 is shared by both chips,
// power is NA in the summary table, and the proc section reports no processes.
const NPU_INFO_310P = `+--------------------------------------------------------------------------------------------------------+
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
+===============================+=================+======================================================+
+-------------------------------+-----------------+------------------------------------------------------+
| NPU     Chip                  | Process id      | Process name             | Process memory(MB)        |
+===============================+=================+======================================================+
| No running processes found in NPU 1536                                                                 |
+===============================+=================+======================================================+`;

const NPU_POWER_310P = `+-------------------------------+------------------------------------------------------+
| npu-smi v1.0                  Version: 24.1.rc4.b999                                 |
+===============================+======================================================+
| NPU Real-time Power(W)        : 60.5                                                 |
| Chip ID                       : 0                                                    |
| NPU Real-time Power(W)        : 61.5                                                 |
| Chip ID                       : 1                                                    |
+-------------------------------+------------------------------------------------------+`;

const NPU_PROC_310P = `+-------------------------------+-----------------+------------------------------------------------------+
| NPU     Chip                  | Process id      | Process name             | Process memory(MB)        |
+===============================+=================+======================================================+
| 1536    1                     | 2201            | mindie-service           | 512                       |
+-------------------------------+-----------------+------------------------------------------------------+`;

const NPU_INFO_KEY_VALUE = `NPU ID                     : 3
Product Name               : Ascend 910B4
Health                     : OK
Power(W)                   : 150.0
Temperature(C)             : 44
AICore(%)                  : 20
Memory-Usage(MB)           : 1024 / 32768`;

function ascendRunner(responses) {
  return { async execFile(command, args) {
    const key = args.join(' ');
    const output = responses[key];
    if (output === undefined) throw Object.assign(new Error('unknown call: ' + command + ' ' + key), { code: 'ENOENT' });
    if (output instanceof Error) throw output;
    return { stdout: output };
  } };
}

test('Ascend table parsing reports 910B cards with chip utilization, memory, and model power limit', () => {
  const cards = parseNpuSmiCards(NPU_INFO_910B);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((card) => card.nativeIndex), [0, 1]);
  assert.equal(cards[0].name, 'Ascend 910B3');
  assert.equal(cards[0].utilizationPercent, 87);
  assert.equal(cards[0].temperatureCelsius, 52);
  assert.equal(cards[0].memory.usedBytes, 45312 * MIB);
  assert.equal(cards[0].memory.totalBytes, 65536 * MIB);
  assert.equal(cards[0].drawWatts, 285);
  assert.equal(cards[0].powerLimitWatts, 350);
  assert.equal(cards[1].utilizationPercent, 15);
  assert.equal(cards[1].memory.usedBytes, 2048 * MIB);
});

test('Ascend 310P physical card ids are renumbered to runtime device ids and power starts unknown', () => {
  const cards = parseNpuSmiCards(NPU_INFO_310P);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((card) => card.reportedIndex), [1536, 1536]);
  assert.deepEqual(cards.map((card) => card.nativeIndex), [0, 1]);
  assert.deepEqual(cards.map((card) => card.chipId), [0, 1]);
  assert.deepEqual(cards.map((card) => card.drawWatts), [null, null]);
  assert.deepEqual(cards.map((card) => card.powerLimitWatts), [90, 90]);
  assert.equal(cards[1].utilizationPercent, 42);
  assert.equal(cards[1].memory.totalBytes, 89085 * MIB);
});

test('Ascend key-value output from npu-smi info -i parses a single card', () => {
  const cards = parseNpuSmiCards(NPU_INFO_KEY_VALUE);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].nativeIndex, 0);
  assert.equal(cards[0].name, 'Ascend 910B4');
  assert.equal(cards[0].utilizationPercent, 20);
  assert.equal(cards[0].drawWatts, 150);
  assert.equal(cards[0].powerLimitWatts, 310);
  assert.equal(cards[0].memory.usedBytes, 1024 * MIB);
});

test('Ascend process rows map onto the chip of the shared physical card', () => {
  const cards = parseNpuSmiCards(NPU_INFO_310P);
  const usagesByPid = parseNpuSmiProcesses(NPU_PROC_310P, cards);
  assert.deepEqual([...usagesByPid.keys()], [2201]);
  const [usage] = usagesByPid.get(2201);
  assert.equal(usage.deviceKey, 'ascend:1');
  assert.equal(usage.nativeIndex, 1);
  assert.equal(usage.mappingStatus, 'matched');
  assert.equal(usage.memoryUsedBytes, 512 * MIB);
});

test('Ascend collect enriches missing power per card, resolves ownership, and marks occupancy idle', async () => {
  const provider = new AscendProvider({ userId: 1000, commandRunner: ascendRunner({
    info: NPU_INFO_310P,
    'info -t power -i 1536': NPU_POWER_310P,
    'info -t proc': NPU_PROC_310P,
    '-p 2201 -o pid=,uid=,user:32=,lstart=': '2201 1000 train Thu Nov 20 10:00:00 2025\n',
  }) });
  const value = await provider.collect();
  assert.equal(value.devices.length, 2);
  const [first, second] = value.devices;
  assert.equal(first.deviceKey, 'ascend:0');
  assert.deepEqual(first.power, { drawWatts: 60.5, limitWatts: 90 });
  assert.deepEqual(second.power, { drawWatts: 61.5, limitWatts: 90 });
  assert.equal(value.occupancyKnown, true);
  const [usage] = value.usagesByPid.get(2201);
  assert.equal(usage.deviceKey, 'ascend:1');
  assert.equal(usage.userName, 'train');
  assert.equal(usage.identityKnown, true);
  assert.deepEqual(value.currentUserDeviceKeys, ['ascend:1']);
});

test('Ascend collect reports unknown idle count when the process query fails but keeps card metrics', async () => {
  const provider = new AscendProvider({ userId: 1000, commandRunner: ascendRunner({
    info: NPU_INFO_910B,
    'info -t proc': Object.assign(new Error('proc query failed'), { code: 'EPERM' }),
  }) });
  const value = await provider.collect();
  assert.equal(value.devices.length, 2);
  assert.equal(value.occupancyKnown, false);
  assert.equal(value.collectionErrors[0].code, 'GPU_OCCUPANCY_UNAVAILABLE');
});

test('the accelerator collector skips a missing npu-smi silently and keeps NVIDIA results', async () => {
  const { NvidiaProvider } = require('../src/accelerators/nvidia-provider');
  const missing = new NvidiaProvider({ commandRunner: ascendRunner({}) });
  const ascend = new AscendProvider({ userId: 1000, commandRunner: ascendRunner({
    info: NPU_INFO_910B,
    'info -t proc': '| No running processes found in NPU 0\n',
  }) });
  const store = new SnapshotStore();
  const runner = new CollectorRunner({ key: 'accelerators', collector: new AcceleratorCollector({ providers: [missing, ascend] }), snapshotStore: store, timeoutMilliseconds: 1000 });
  await runner.run();
  await runner.idle;
  const snapshot = store.read();
  assert.equal(snapshot.accelerators.lastError, null);
  assert.deepEqual(snapshot.accelerators.value.devices.map((device) => device.provider), ['ascend', 'ascend']);
  assert.equal(snapshot.accelerators.value.occupancyKnown, true);
});

test('the accelerator collector combines NVIDIA and Ascend devices', async () => {
  const { NvidiaProvider } = require('../src/accelerators/nvidia-provider');
  const nvidia = new NvidiaProvider({ userId: 1000, commandRunner: ascendRunner({
    '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,gpu_uuid --format=csv,noheader,nounits': '0, NVIDIA GeForce RTX 3080, 45, 2048, 10240, 65, 120.5, 320.0, GPU-abc-123\n',
    '--query-compute-apps=pid,gpu_uuid,used_memory --format=csv,noheader,nounits': '',
  }) });
  const ascend = new AscendProvider({ userId: 1000, commandRunner: ascendRunner({
    info: NPU_INFO_910B,
    'info -t proc': '| No running processes found in NPU 0\n',
  }) });
  const store = new SnapshotStore();
  const runner = new CollectorRunner({ key: 'accelerators', collector: new AcceleratorCollector({ providers: [nvidia, ascend] }), snapshotStore: store, timeoutMilliseconds: 1000 });
  await runner.run();
  await runner.idle;
  const value = store.read().accelerators.value;
  assert.deepEqual(value.devices.map((device) => device.deviceKey), ['nvidia:GPU-abc-123', 'ascend:0', 'ascend:1']);
});
