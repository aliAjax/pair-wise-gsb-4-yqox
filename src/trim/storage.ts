// 静音裁切存储层：localStorage 持久化与状态流转（不可变更新）
import { checkTrim, complement, mergeRanges, rangeDuration } from './validation';
import type { Recording, SilenceRange, TrimStore, TrimVersion } from './types';

const STORAGE_KEY = 'sound-lab-trims-v1';

export interface NewRecordingInput {
  phraseId: number;
  phraseText: string;
  originalDuration: number;
  /** 原始录音检测到的静音区间，默认无 */
  silences?: SilenceRange[];
}

export type DraftSaveError = 'DRAFT_EXISTS';
export interface MutationResult {
  store: TrimStore;
  error?: DraftSaveError;
  /** 冲突时占用该句子待确认项的录音 id */
  conflictRecordingId?: number;
}

function versionOf(silences: SilenceRange[], duration: number, version: number, at: number): TrimVersion {
  const normalized = [...silences].sort((a, b) => a.start - b.start);
  const kept = complement(normalized, duration);
  return { silences: normalized, kept, duration: rangeDuration(kept), version, confirmedAt: at };
}

export function createRecording(store: TrimStore, input: NewRecordingInput, now = Date.now()): { store: TrimStore; recording: Recording } {
  const duration = Math.max(0, Math.round(input.originalDuration * 10) / 10);
  const recording: Recording = {
    id: store.nextId,
    phraseId: input.phraseId,
    phraseText: input.phraseText,
    originalDuration: duration,
    recordedAt: now,
    versions: [versionOf(input.silences ?? [], duration, 1, now)],
  };
  return { store: { ...store, recordings: [recording, ...store.recordings], nextId: store.nextId + 1 }, recording };
}

/** 保存（或更新某条录音的）待确认裁切；同一句子只允许一个待确认项 */
export function saveDraft(
  store: TrimStore,
  recordingId: number,
  phraseId: number,
  silences: SilenceRange[],
): MutationResult {
  const owner = store.drafts.find(d => d.phraseId === phraseId && d.recordingId !== recordingId);
  if (owner) return { store, error: 'DRAFT_EXISTS', conflictRecordingId: owner.recordingId };
  const normalized = [...silences].sort((a, b) => a.start - b.start);
  const drafts = store.drafts.filter(d => d.recordingId !== recordingId);
  drafts.push({ recordingId, phraseId, silences: normalized });
  return { store: { ...store, drafts } };
}

export function discardDraft(store: TrimStore, recordingId: number): TrimStore {
  return { ...store, drafts: store.drafts.filter(d => d.recordingId !== recordingId) };
}

/** 确认裁切：以原始录音时间轴为基准再次校验，通过后把新静音并入，生成新版本 */
export function confirmTrim(
  store: TrimStore,
  recordingId: number,
  input: Array<{ start: number | string; end: number | string }>,
  now = Date.now(),
): { store: TrimStore; error?: ReturnType<typeof checkTrim>['error'] } {
  const recording = store.recordings.find(r => r.id === recordingId);
  if (!recording) return { store, error: 'OUT_OF_BOUNDS' };
  const current = recording.versions[0];
  // 先校验新输入自身（形状/反向/越界/内部重叠）
  const self = checkTrim(input, { duration: recording.originalDuration });
  if (!self.ok) return { store, error: self.error };
  const EPS_LOCAL = 1e-6;
  // 检测新静音是否与任一既有静音有非空交集；完全相同的重复提交允许（并集不变）
  const intrudes = self.normalized.some(n =>
    current.silences.some(s => {
      const left = Math.max(n.start, s.start);
      const right = Math.min(n.end, s.end);
      if (right <= left + EPS_LOCAL) return false; // 不相交或仅端点相接
      const identical = Math.abs(n.start - s.start) <= EPS_LOCAL && Math.abs(n.end - s.end) <= EPS_LOCAL;
      return !identical;
    }),
  );
  if (intrudes) return { store, error: 'OVERLAP' };
  // 合并既有与新增静音（重复/端点相接自动归并），再做覆盖与最短时长校验
  const check = checkTrim(mergeRanges([...current.silences, ...self.normalized]), { duration: recording.originalDuration });
  if (!check.ok) return { store, error: check.error };
  const next: TrimVersion = {
    silences: check.normalized,
    kept: check.kept,
    duration: Math.round(check.keptDuration * 100) / 100,
    version: current.version + 1,
    confirmedAt: now,
  };
  return {
    store: {
      ...store,
      recordings: store.recordings.map(r =>
        r.id === recordingId ? { ...r, versions: [next, ...r.versions] } : r,
      ),
      drafts: store.drafts.filter(d => d.recordingId !== recordingId),
    },
  };
}

/** 撤销最近一次已确认裁切：移除当前版本，回到紧邻的上一版本 */
export function undoLastConfirm(store: TrimStore, recordingId: number): TrimStore {
  return {
    ...store,
    recordings: store.recordings.map(r =>
      r.id === recordingId && r.versions.length > 1
        ? { ...r, versions: r.versions.slice(1) }
        : r,
    ),
  };
}

export function getDraft(store: TrimStore, recordingId: number) {
  return store.drafts.find(d => d.recordingId === recordingId);
}

// ---------- localStorage ----------

function seedStore(): TrimStore {
  let store: TrimStore = { recordings: [], drafts: [], nextId: 1 };
  const day = 86400000;
  const base = new Date('2026-09-18T09:00:00').getTime();
  const mk = (input: NewRecordingInput): Recording => {
    const res = createRecording(store, input, base + store.nextId * day);
    store = res.store;
    return res.recording;
  };
  const r1 = mk({
    phraseId: 1,
    phraseText: 'The morning light feels different today.',
    originalDuration: 9.2,
    silences: [{ start: 0, end: 0.6 }],
  });
  mk({
    phraseId: 3,
    phraseText: 'I appreciate your patience and thoughtful feedback.',
    originalDuration: 11.5,
    silences: [
      { start: 4.2, end: 5.1 },
      { start: 9.8, end: 10.5 },
    ],
  });
  const r3 = mk({
    phraseId: 2,
    phraseText: 'Could you walk me through the next step?',
    originalDuration: 4.8,
    silences: [],
  });
  // 一个已生成新版本的示例
  store = confirmTrim(store, r3.id, [
    { start: 0, end: 0.4 },
    { start: 4.3, end: 4.8 },
  ], new Date('2026-09-20T20:15:00').getTime()).store;
  // 一个待确认裁切
  store = saveDraft(store, r1.id, 1, [
    { start: 0, end: 0.6 },
    { start: 8.6, end: 9.2 },
  ]).store;
  return store;
}

function isRange(v: unknown): v is SilenceRange {
  return !!v && typeof v === 'object'
    && Number.isFinite((v as SilenceRange).start)
    && Number.isFinite((v as SilenceRange).end)
    && (v as SilenceRange).end >= (v as SilenceRange).start;
}

function repairVersion(v: unknown, fallbackDuration: number): TrimVersion | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as TrimVersion;
  if (!Array.isArray(o.silences) || !o.silences.every(isRange)) return null;
  const hasKept = Array.isArray(o.kept) && o.kept.every(isRange);
  const kept = hasKept ? o.kept : complement(o.silences, fallbackDuration);
  // kept 缺失时，时长必须按补集重算，不能直接沿用原始时长
  const duration = hasKept && Number.isFinite(o.duration) && o.duration >= 0 ? o.duration : rangeDuration(kept);
  return {
    silences: [...o.silences].sort((a, b) => a.start - b.start),
    kept,
    duration,
    version: Number.isFinite(o.version) ? o.version : 1,
    confirmedAt: Number.isFinite(o.confirmedAt) ? o.confirmedAt : Date.now(),
  };
}

/** 读取持久化数据；缺失或损坏时回落到示例数据，保证刷新后状态一致 */
export function loadTrimStore(): TrimStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const seeded = seedStore();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
      return seeded;
    }
    const parsed = JSON.parse(raw) as Partial<TrimStore>;
    const recordings: Recording[] = [];
    let maxId = 0;
    for (const r of Array.isArray(parsed.recordings) ? parsed.recordings : []) {
      if (!r || typeof r !== 'object') continue;
      const rec = r as Recording;
      if (!Number.isFinite(rec.id) || !Number.isFinite(rec.originalDuration) || !Array.isArray(rec.versions) || rec.versions.length === 0) continue;
      const versions = rec.versions
        .map(v => repairVersion(v, rec.originalDuration))
        .filter((v): v is TrimVersion => v !== null);
      if (versions.length === 0) continue;
      recordings.push({
        id: rec.id,
        phraseId: rec.phraseId,
        phraseText: String(rec.phraseText ?? '未登记句子'),
        originalDuration: rec.originalDuration,
        recordedAt: Number.isFinite(rec.recordedAt) ? rec.recordedAt : Date.now(),
        versions,
      });
      maxId = Math.max(maxId, rec.id);
    }
    const validIds = new Set(recordings.map(r => r.id));
    const phraseOwners = new Map<number, number>();
    const drafts = (Array.isArray(parsed.drafts) ? parsed.drafts : []).flatMap(d => {
      if (!d || typeof d !== 'object') return [];
      const draft = d as TrimStore['drafts'][number];
      if (!validIds.has(draft.recordingId) || !Number.isFinite(draft.phraseId)) return [];
      if (!Array.isArray(draft.silences) || !draft.silences.every(isRange)) return [];
      // 同一句子只保留一个待确认项
      if (phraseOwners.has(draft.phraseId)) return [];
      phraseOwners.set(draft.phraseId, draft.recordingId);
      return [{ recordingId: draft.recordingId, phraseId: draft.phraseId, silences: draft.silences }];
    });
    return { recordings, drafts, nextId: Math.max(Number(parsed.nextId) || 0, maxId + 1) };
  } catch {
    return seedStore();
  }
}

export function saveTrimStore(store: TrimStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // 存储不可用时静默降级，内存状态仍可操作
  }
}
