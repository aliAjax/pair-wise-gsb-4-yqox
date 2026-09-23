// 静音裁切 · 存储层：localStorage 持久化 + 纯状态转移，React 通过 useCropStore 订阅
import { useSyncExternalStore } from 'react';
import { deriveVoiced, normalizeRanges, validatePreview } from './logic';
import type {
  CropStoreData,
  CropVersion,
  PendingCrop,
  PreviewResult,
  Recording,
  SecondsRange,
} from './types';

const STORAGE_KEY = 'sound-lab-crops-v1';

export const nowStamp = (): string => new Date().toISOString();

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 从 localStorage 读取；结构损坏时回退为空数据，绝不抛错 */
export function loadStore(): CropStoreData {
  const empty: CropStoreData = { recordings: [], pending: {} };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedStore();
    const parsed = JSON.parse(raw) as Partial<CropStoreData>;
    if (!parsed || !Array.isArray(parsed.recordings) || typeof parsed.pending !== 'object' || parsed.pending === null) {
      return empty;
    }
    return { recordings: parsed.recordings, pending: parsed.pending ?? {} };
  } catch {
    return empty;
  }
}

/** 首次使用时的示例数据：两条已登记录音，便于直接演示侧栏 */
function seedStore(): CropStoreData {
  const mk = (
    id: string,
    phraseId: number,
    phrase: string,
    duration: number,
    silences: SecondsRange[],
    createdAt: string,
  ): Recording => {
    const voiced = deriveVoiced(duration, silences);
    const original: CropVersion = {
      version: 0,
      sourceRecordingId: id,
      silences: normalizeRanges(silences),
      voiced,
      sourceDuration: duration,
      kept: [{ start: 0, end: duration }],
      croppedDuration: duration,
      confirmedAt: createdAt,
    };
    return { id, phraseId, phrase, createdAt, versions: [original] };
  };
  const data: CropStoreData = {
    recordings: [
      mk('seed-rec-1', 1, 'The morning light feels different today.', 8.2, [
        { start: 0, end: 0.6 },
        { start: 3.1, end: 3.9 },
        { start: 7.4, end: 8.2 },
      ], '2026-09-23T01:24:00.000Z'),
      mk('seed-rec-2', 3, 'I appreciate your patience and thoughtful feedback.', 11.5, [
        { start: 0, end: 0.8 },
        { start: 5.2, end: 6.4 },
        { start: 10.6, end: 11.5 },
      ], '2026-09-23T02:10:00.000Z'),
    ],
    pending: {},
  };
  return data;
}

function persist(data: CropStoreData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // 存储不可用时静默降级，内存状态仍可用
  }
}

// ---- 纯状态转移：均返回新 data（或附带 error），不修改入参 ----

export interface RegisterInput {
  phraseId: number;
  phrase: string;
  duration: number;
  silences: SecondsRange[];
  createdAt: string;
}

export function registerRecording(prev: CropStoreData, input: RegisterInput): CropStoreData {
  const id = uid();
  const voiced = deriveVoiced(input.duration, input.silences);
  const original: CropVersion = {
    version: 0,
    sourceRecordingId: id,
    silences: normalizeRanges(input.silences),
    voiced,
    sourceDuration: input.duration,
    kept: [{ start: 0, end: input.duration }],
    croppedDuration: input.duration,
    confirmedAt: input.createdAt,
  };
  const recording: Recording = {
    id,
    phraseId: input.phraseId,
    phrase: input.phrase,
    createdAt: input.createdAt,
    versions: [original],
  };
  return { ...prev, recordings: [recording, ...prev.recordings] };
}

export interface PendingInput {
  phraseId: number;
  recordingId: string;
  kept: SecondsRange[];
  createdAt: string;
}

export type PendingResult =
  | { ok: true; data: CropStoreData; preview: Extract<PreviewResult, { ok: true }> }
  | { ok: false; data: CropStoreData; preview: Extract<PreviewResult, { ok: false }> };

/** 提交预览：校验通过则写入/替换该句子的待确认项；失败则原样返回（保留原值） */
export function submitPending(prev: CropStoreData, input: PendingInput): PendingResult {
  const recording = prev.recordings.find((r) => r.id === input.recordingId);
  if (!recording) {
    return {
      ok: false,
      data: prev,
      preview: { ok: false, reason: 'out-of-bounds', detail: '录音不存在或已被删除' },
    };
  }
  const sourceVersion = recording.versions.length - 1;
  const source = recording.versions[sourceVersion];
  const preview = validatePreview(input.kept, {
    duration: source.sourceDuration,
    voiced: source.voiced,
  });
  if (!preview.ok) {
    // 拒绝预览：状态不变，调用方继续保留输入框原值
    return { ok: false, data: prev, preview };
  }

  // 同一句子只能有一个待确认：替换该句子已有的待确认项
  const nextPending: Record<string, PendingCrop> = {};
  for (const [pid, p] of Object.entries(prev.pending)) {
    if (p.phraseId !== input.phraseId) nextPending[pid] = p;
  }
  const pending: PendingCrop = {
    id: uid(),
    phraseId: input.phraseId,
    sourceRecordingId: input.recordingId,
    sourceVersion,
    kept: preview.kept,
    croppedDuration: preview.croppedDuration,
    createdAt: input.createdAt,
  };
  nextPending[pending.id] = pending;
  return { ok: true, data: { ...prev, pending: nextPending }, preview };
}

export type ConfirmResult =
  | { ok: true; data: CropStoreData; version: number }
  | { ok: false; data: CropStoreData; error: string };

/** 确认裁切：追加一个不可变新版本，移除待确认项；旧版本保留可查 */
export function confirmPending(prev: CropStoreData, pendingId: string, confirmedAt: string): ConfirmResult {
  const pending = prev.pending[pendingId];
  if (!pending) return { ok: false, data: prev, error: '待确认项不存在' };
  const recording = prev.recordings.find((r) => r.id === pending.sourceRecordingId);
  if (!recording) return { ok: false, data: prev, error: '来源录音不存在' };

  // 确认前以当前最新版本再校验一次，避免区间与最新状态脱节
  const source = recording.versions[recording.versions.length - 1];
  const preview = validatePreview(pending.kept, {
    duration: source.sourceDuration,
    voiced: source.voiced,
  });
  if (!preview.ok) {
    // 状态已变化导致不再合法：丢弃该待确认项，要求重新预览
    const nextPending = { ...prev.pending };
    delete nextPending[pendingId];
    return { ok: false, data: { ...prev, pending: nextPending }, error: preview.detail };
  }

  const newVersion: CropVersion = {
    version: recording.versions.length,
    sourceRecordingId: recording.id,
    silences: source.silences,
    voiced: source.voiced,
    sourceDuration: source.sourceDuration,
    kept: preview.kept,
    croppedDuration: preview.croppedDuration,
    confirmedAt,
  };
  const nextPending = { ...prev.pending };
  delete nextPending[pendingId];
  const recordings = prev.recordings.map((r) =>
    r.id === recording.id ? { ...r, versions: [...r.versions, newVersion] } : r,
  );
  return { ok: true, data: { recordings, pending: nextPending }, version: newVersion.version };
}

/** 放弃待确认（不影响任何已确认数据） */
export function cancelPending(prev: CropStoreData, pendingId: string): CropStoreData {
  if (!prev.pending[pendingId]) return prev;
  const nextPending = { ...prev.pending };
  delete nextPending[pendingId];
  return { ...prev, pending: nextPending };
}

export type UndoResult =
  | { ok: true; data: CropStoreData }
  | { ok: false; data: CropStoreData; error: string };

/**
 * 撤销：仅删除最近一次“已确认”的裁切版本，回到上一个版本。
 * 原始版本（version 0）不可撤销；该句子存在待确认项时禁止撤销。
 */
export function undoLastConfirmed(prev: CropStoreData, recordingId: string): UndoResult {
  const recording = prev.recordings.find((r) => r.id === recordingId);
  if (!recording) return { ok: false, data: prev, error: '录音不存在' };
  const blocking = Object.values(prev.pending).some((p) => p.phraseId === recording.phraseId);
  if (blocking) return { ok: false, data: prev, error: '请先确认或放弃待确认裁切' };
  if (recording.versions.length <= 1) return { ok: false, data: prev, error: '原始录音无可撤销的裁切' };
  const recordings = prev.recordings.map((r) =>
    r.id === recordingId ? { ...r, versions: r.versions.slice(0, -1) } : r,
  );
  return { ok: true, data: { ...prev, recordings } };
}

/** 删除整条录音（及其版本链）；其待确认项一并清除 */
export function removeRecording(prev: CropStoreData, recordingId: string): CropStoreData {
  const recording = prev.recordings.find((r) => r.id === recordingId);
  const recordings = prev.recordings.filter((r) => r.id !== recordingId);
  const pending = { ...prev.pending };
  if (recording) {
    for (const [pid, p] of Object.entries(pending)) {
      if (p.phraseId === recording.phraseId && p.sourceRecordingId === recordingId) delete pending[pid];
    }
  }
  return { recordings, pending };
}

// ---- 微型外部 store + React 订阅 ----

let state: CropStoreData = loadStore();
const listeners = new Set<() => void>();

function setState(next: CropStoreData): void {
  if (next === state) return;
  state = next;
  persist(state);
  listeners.forEach((l) => l());
}

export const cropStore = {
  getState: () => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  register(input: RegisterInput): void {
    setState(registerRecording(state, input));
  },
  submit(input: PendingInput): PendingResult {
    const result = submitPending(state, input);
    if (result.ok) setState(result.data);
    return result;
  },
  confirm(pendingId: string): ConfirmResult {
    const result = confirmPending(state, pendingId, nowStamp());
    setState(result.data);
    return result;
  },
  cancel(pendingId: string): void {
    setState(cancelPending(state, pendingId));
  },
  undo(recordingId: string): UndoResult {
    const result = undoLastConfirmed(state, recordingId);
    setState(result.data);
    return result;
  },
  remove(recordingId: string): void {
    setState(removeRecording(state, recordingId));
  },
};

/** 页面层订阅入口：刷新后与 localStorage 中的录音、版本、待确认项保持一致 */
export function useCropStore(): CropStoreData {
  return useSyncExternalStore(cropStore.subscribe, cropStore.getState, cropStore.getState);
}
