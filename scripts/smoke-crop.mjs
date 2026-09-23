// 无额外依赖冒烟测试：用项目已装的 tsc 编译器把 crop 模块编到临时目录后运行
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'crop-smoke-'));
const tsc = join(process.cwd(), 'node_modules/typescript/lib/tsc.js');

// 用临时 tsconfig 编译（忽略仓库根配置），输出 ESM JS
writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    module: 'esnext',
    target: 'es2020',
    moduleResolution: 'bundler',
    jsx: 'react-jsx',
    rootDir: join(process.cwd(), 'src'),
    outDir: join(dir, 'out'),
    skipLibCheck: true,
  },
  include: [join(process.cwd(), 'src/crop')],
}));
execFileSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json'), '--ignoreConfig'], { stdio: 'pipe' });

const outDir = join(dir, 'out');
const cropOut = join(outDir, 'crop');
// ESM 需要显式扩展名；并把 react 指向 shim
for (const f of readdirSync(cropOut)) {
  if (!f.endsWith('.js')) continue;
  let code = readFileSync(join(cropOut, f), 'utf8');
  code = code.replace(/from '(\.\/types)'/g, "from '$1.js'").replace(/from '(\.\/logic)'/g, "from '$1.js'");
  code = code.replace(/from 'react'/g, "from '../react-shim.mjs'");
  writeFileSync(join(cropOut, f), code);
}
writeFileSync(join(outDir, 'react-shim.mjs'), 'export const useSyncExternalStore = () => null;\nexport default {};');

// --- localStorage shim ---
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const mod = await import(pathToFileURL(join(cropOut, 'store.js')).href);
const {
  registerRecording,
  submitPending,
  confirmPending,
  cancelPending,
  undoLastConfirmed,
  removeRecording,
  loadStore,
  cropStore,
} = mod;

let pass = 0;
let fail = 0;
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      expected ${e}\n      actual   ${a}`); }
};
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

mem.clear();
mem.set('sound-lab-crops-v1', JSON.stringify({ recordings: [], pending: {} }));
const now = '2026-09-23T03:00:00.000Z';

// 登记录音：时长 10s，静音 [0-0.8],[4-5],[9.2-10] → 有效 [0.8-4],[5-9.2]
let s0 = registerRecording(loadStore(), {
  phraseId: 1, phrase: 'test phrase', duration: 10,
  silences: [{ start: 0, end: 0.8 }, { start: 4, end: 5 }, { start: 9.2, end: 10 }],
  createdAt: now,
});
const recId = s0.recordings[0].id;
const v0 = s0.recordings[0].versions[0];
ok('登记后只有原始版本 v0', s0.recordings[0].versions.length === 1);
eq('有效音段由静音补集推导', v0.voiced, [{ start: 0.8, end: 4 }, { start: 5, end: 9.2 }]);
eq('原始版本保留区间为整段', v0.kept, [{ start: 0, end: 10 }]);

// 规则1：越界
let r = submitPending(s0, { phraseId: 1, recordingId: recId, kept: [{ start: 0, end: 10.5 }], createdAt: now });
ok('越界区间被拒绝', !r.ok && r.preview.reason === 'out-of-bounds');
ok('拒绝后状态保持原值', r.data === s0);
r = submitPending(s0, { phraseId: 1, recordingId: recId, kept: [{ start: -0.1, end: 5 }], createdAt: now });
ok('负起点被拒绝', !r.ok && r.preview.reason === 'out-of-bounds');

// 规则2：重叠
r = submitPending(s0, { phraseId: 1, recordingId: recId, kept: [{ start: 0, end: 5 }, { start: 4, end: 8 }], createdAt: now });
ok('重叠区间被拒绝', !r.ok && r.preview.reason === 'overlap');

// 规则3：不足三秒
r = submitPending(s0, { phraseId: 1, recordingId: recId, kept: [{ start: 0.8, end: 2.8 }], createdAt: now });
ok('不足三秒被拒绝', !r.ok && r.preview.reason === 'too-short');

// 规则4：覆盖全部有效音段
r = submitPending(s0, { phraseId: 1, recordingId: recId,
  kept: [{ start: 0.8, end: 4 }, { start: 5, end: 9.2 }], createdAt: now });
ok('覆盖全部有效音段被拒绝', !r.ok && r.preview.reason === 'covers-all-voiced');
r = submitPending(s0, { phraseId: 1, recordingId: recId, kept: [{ start: 0, end: 10 }], createdAt: now });
ok('整段保留被拒（覆盖全部音段）', !r.ok && r.preview.reason === 'covers-all-voiced');

// 合法裁切：保留 [0.8-4] + [5-8] = 6.2s，有声 [5-9.2] 未被完整覆盖
r = submitPending(s0, { phraseId: 1, recordingId: recId,
  kept: [{ start: 0.8, end: 4 }, { start: 5, end: 8 }], createdAt: now });
ok('合法裁切预览通过', r.ok);
ok('裁切后时长 6.2s', Math.abs(r.preview.croppedDuration - 6.2) < 1e-9);
let s1 = r.data;
ok('待确认项写入存储', Object.keys(s1.pending).length === 1);

// 同一句子只能有一个待确认
r = submitPending(s1, { phraseId: 1, recordingId: recId,
  kept: [{ start: 0.8, end: 4 }, { start: 5, end: 9 }], createdAt: now });
ok('同句重复提交仍只有一个待确认', r.ok && Object.keys(r.data.pending).length === 1);
s1 = r.data;
const pid = Object.keys(s1.pending)[0]; // 替换后取最新待确认 id

// 另一句子可各有一个
const other = registerRecording(s1, { phraseId: 2, phrase: 'second', duration: 6,
  silences: [{ start: 0, end: 0.5 }], createdAt: now });
const rec2 = other.recordings[0].id;
r = submitPending(other, { phraseId: 2, recordingId: rec2, kept: [{ start: 0.5, end: 5.5 }], createdAt: now });
ok('不同句子各自有待确认项', r.ok && Object.keys(r.data.pending).length === 2);

// 确认：新版本 + 旧版本保留 + 待确认移除
let c = confirmPending(r.data, Object.keys(r.data.pending).find((k) => r.data.pending[k].phraseId === 2), now);
ok('确认成功生成 v1', c.ok && c.version === 1);
ok('确认后追加不可变新版本', c.data.recordings.find((x) => x.id === rec2).versions.length === 2);
ok('旧版本 v0 仍可查', c.data.recordings.find((x) => x.id === rec2).versions[0].version === 0);
ok('确认后待确认项移除', Object.keys(c.data.pending).length === 1);

// 撤销
let u = undoLastConfirmed(c.data, rec2);
ok('撤销删除最新裁切版本', u.ok && u.data.recordings.find((x) => x.id === rec2).versions.length === 1);
u = undoLastConfirmed(u.data, rec2);
ok('原始版本不可撤销', !u.ok);
const sPending = Object.keys(c.data.pending)[0];
u = undoLastConfirmed(c.data, recId);
ok('存在同句待确认时禁止撤销', !u.ok);

// 放弃待确认
const afterCancel = cancelPending(c.data, sPending);
ok('放弃待确认后 pending 清空', Object.keys(afterCancel.pending).length === 0);
ok('放弃不影响已确认版本数', afterCancel.recordings.find((x) => x.id === rec2).versions.length === 2);

// 删除录音
const withDel = removeRecording(s1, recId);
ok('删除录音移除其待确认项', Object.values(withDel.pending).every((p) => p.sourceRecordingId !== recId));

// 版本链
c = confirmPending(s1, pid, now);
ok('在首条录音确认生成 v1', c.ok);
const chain = c.data.recordings.find((x) => x.id === recId);
ok('版本链为 [v0, v1]', chain.versions.map((v) => v.version).join(',') === '0,1');
eq('v1 保留区间被持久化', chain.versions[1].kept, [{ start: 0.8, end: 4 }, { start: 5, end: 9 }]);
// 链式第二次裁切：v1 → v2
r = submitPending(c.data, { phraseId: 1, recordingId: recId,
  kept: [{ start: 0.8, end: 4 }], createdAt: now });
ok('基于 v1 继续裁切通过（3.2s 且未覆盖音段 [5-9.2]）', r.ok);
const c2 = confirmPending(r.data, Object.keys(r.data.pending)[0], now);
ok('链式确认生成 v2', c2.ok && c2.version === 2);
ok('撤销只回退最近已确认版本（v2→v1）', (() => {
  const back = undoLastConfirmed(c2.data, recId);
  const vs = back.data.recordings.find((x) => x.id === recId).versions;
  return back.ok && vs.length === 2 && vs[1].kept[1].end === 9;
})());

// 刷新一致性
mem.clear();
mem.set('sound-lab-crops-v1', JSON.stringify(c.data));
const reloaded = loadStore();
eq('刷新后版本数一致', reloaded.recordings.find((x) => x.id === recId).versions.length, 2);
ok('刷新后待确认项一致', Object.keys(reloaded.pending).length === 0);
mem.set('sound-lab-crops-v1', '{not json');
eq('损坏 JSON 回退空数据', loadStore(), { recordings: [], pending: {} });
mem.set('sound-lab-crops-v1', JSON.stringify({ recordings: 'x' }));
eq('结构非法回退空数据', loadStore(), { recordings: [], pending: {} });

// store 封装端到端
mem.clear();
let events = 0;
const unsub = cropStore.subscribe(() => events++);
cropStore.register({ phraseId: 9, phrase: 'e2e', duration: 7, silences: [{ start: 0, end: 1 }], createdAt: now });
const e2eId = cropStore.getState().recordings[0].id;
ok('store 订阅在变更时触发', events === 1);
const subRes = cropStore.submit({ phraseId: 9, recordingId: e2eId, kept: [{ start: 1, end: 6.5 }], createdAt: now });
ok('store 提交合法预览', subRes.ok);
const e2ePid = Object.keys(cropStore.getState().pending)[0];
const conf = cropStore.confirm(e2ePid);
ok('store 确认生成新版本', conf.ok && conf.version === 1);
const before = events;
const bad = cropStore.submit({ phraseId: 9, recordingId: e2eId, kept: [{ start: 0, end: 2 }], createdAt: now });
ok('被拒提交不触发订阅且数据不变', !bad.ok && events === before && cropStore.getState().recordings[0].versions.length === 2);
const persisted = JSON.parse(mem.get('sound-lab-crops-v1'));
ok('每次变更落盘', persisted.recordings[0].versions.length === 2 && Object.keys(persisted.pending).length === 0);
unsub();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
