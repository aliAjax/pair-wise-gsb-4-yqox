// 静音裁切 · 判定层：区间运算与校验规则，全部为纯函数，不接触 DOM / 存储 / React
import type {
  PendingCrop,
  PreviewResult,
  RecordingEntry,
  RejectReason,
  SecondsRange,
} from './types';

export const MIN_CROP_SECONDS = 3;

/** 区间长度 */
export const rangeLen = (r: SecondsRange): number => r.end - r.start;

/** 合并区间长度之和 */
export const sumLen = (ranges: SecondsRange[]): number =>
  ranges.reduce((acc, r) => acc + rangeLen(r), 0);

/** 区间是否合法：端点为有限数、start < end */
export const isValidRange = (r: SecondsRange): boolean =>
  Number.isFinite(r.start) && Number.isFinite(r.end) && r.start < r.end;

/** 按起点排序并合并相交/相接区间；过滤非法区间 */
export function normalizeRanges(ranges: SecondsRange[]): SecondsRange[] {
  const sorted = ranges
    .filter(isValidRange)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);
  const out: SecondsRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** 由静音区间推导 [0, duration) 上的有效（有声）区间 */
export function deriveVoiced(duration: number, silences: SecondsRange[]): SecondsRange[] {
  if (!(duration > 0)) return [];
  const clipped = normalizeRanges(
    silences
      .filter((r) => r.end > 0 && r.start < duration)
      .map((r) => ({ start: Math.max(0, r.start), end: Math.min(duration, r.end) })),
  );
  const voiced: SecondsRange[] = [];
  let cursor = 0;
  for (const s of clipped) {
    if (s.start > cursor) voiced.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) voiced.push({ start: cursor, end: duration });
  return voiced;
}

/** 拒绝原因的中文说明 */
export const REJECT_MESSAGES: Record<RejectReason, string> = {
  'out-of-bounds': '存在超出录音时长（0 秒起）的区间',
  overlap: '保留区间之间存在重叠或相接异常',
  'too-short': `裁切后时长不足 ${MIN_CROP_SECONDS} 秒`,
  'covers-all-voiced': '保留区间覆盖了全部有效音段，没有可裁切的内容',
};

/**
 * 预览校验：对“拟保留区间”执行四条硬性规则。
 * 1) 区间越界：任何区间非法或落到 [0, duration) 之外 -> 拒绝，保留原值
 * 2) 区间重叠：保留区间相互重叠 -> 拒绝，保留原值
 * 3) 裁切后不足三秒 -> 拒绝，保留原值
 * 4) 覆盖全部有效音段：每个有声段都被保留区间完整覆盖 -> 拒绝（等于没裁）
 */
export function validatePreview(
  kept: SecondsRange[],
  entry: Pick<RecordingEntry, 'duration' | 'voiced'>,
): PreviewResult {
  // 规则 1：越界（含非法区间）
  const outOfBounds = kept.some(
    (r) =>
      !isValidRange(r) ||
      r.start < 0 ||
      r.end > entry.duration + 1e-9,
  );
  if (outOfBounds) {
    return { ok: false, reason: 'out-of-bounds', detail: REJECT_MESSAGES['out-of-bounds'] };
  }

  // 规则 2：互相重叠（端点相接允许，但 start 相等/穿插不允许）
  const sorted = [...kept].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end - 1e-9) {
      return { ok: false, reason: 'overlap', detail: REJECT_MESSAGES.overlap };
    }
  }

  const croppedDuration = sumLen(kept);

  // 规则 3：裁切后不足三秒
  if (croppedDuration + 1e-9 < MIN_CROP_SECONDS) {
    return { ok: false, reason: 'too-short', detail: REJECT_MESSAGES['too-short'] };
  }

  // 规则 4：覆盖全部有效音段。
  // 只要存在一个有效音段未被任一保留区间完整覆盖，就说明确实裁掉了内容。
  const coversSegment = (seg: SecondsRange) =>
    kept.some((k) => k.start <= seg.start + 1e-9 && k.end >= seg.end - 1e-9);
  const allVoicedCovered =
    entry.voiced.length > 0 && entry.voiced.every(coversSegment);
  if (allVoicedCovered) {
    return {
      ok: false,
      reason: 'covers-all-voiced',
      detail: REJECT_MESSAGES['covers-all-voiced'],
    };
  }

  const coveredVoiced = entry.voiced
    .filter(coversSegment)
    .reduce((acc, seg) => acc + rangeLen(seg), 0);

  return { ok: true, kept: sorted, croppedDuration, coveredVoiced };
}

/** 同一句子是否已存在待确认裁切 */
export function hasPendingFor(
  pending: PendingCrop[],
  phraseId: number,
  exceptId?: string,
): boolean {
  return pending.some((p) => p.phraseId === phraseId && p.id !== exceptId);
}

/** mm:ss 格式化 */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
