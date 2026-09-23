// 静音裁切判定逻辑（纯函数，不依赖 React / localStorage）
import type { SilenceRange } from './types';

export type TrimError =
  | 'EMPTY' // 没有填写任何静音区间
  | 'BAD_SHAPE' // 起点或终点不是有效数字
  | 'REVERSED' // 终点早于起点
  | 'OUT_OF_BOUNDS' // 区间越出原始录音时间范围
  | 'OVERLAP' // 静音区间彼此重叠
  | 'ALL_COVERED' // 静音覆盖了全部有效音段
  | 'TOO_SHORT'; // 裁切后保留时长不足三秒

export const MIN_KEEP_SECONDS = 3;
const EPS = 1e-6;

/** 校验输入的时间坐标范围：所有区间都以原始录音时间轴为准 */
export interface TrimBounds {
  duration: number;
}

export interface TrimCheckResult {
  ok: boolean;
  error?: TrimError;
  /** 归一化后的静音区间（按起点排序，原始时间轴坐标） */
  normalized: SilenceRange[];
  /** 计算出的保留区间（按起点排序，原始时间轴坐标） */
  kept: SilenceRange[];
  /** 保留总时长（秒） */
  keptDuration: number;
}

export const ERROR_TEXT: Record<TrimError, string> = {
  EMPTY: '请至少添加一个静音区间',
  BAD_SHAPE: '静音区间的起点和终点必须是数字',
  REVERSED: '静音区间的终点不能早于起点',
  OUT_OF_BOUNDS: '静音区间超出当前录音的时间范围',
  OVERLAP: '静音区间之间存在重叠',
  ALL_COVERED: '静音覆盖了全部有效音段，将没有可保留内容',
  TOO_SHORT: `裁切后保留时长不足 ${MIN_KEEP_SECONDS} 秒`,
};

/** 把原始输入整理为数值区间；形状不合法时返回 null */
function toRanges(input: Array<{ start: number | string; end: number | string }>): SilenceRange[] | null {
  const out: SilenceRange[] = [];
  for (const r of input) {
    const start = typeof r.start === 'string' ? Number(r.start) : r.start;
    const end = typeof r.end === 'string' ? Number(r.end) : r.end;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    out.push({ start, end });
  }
  return out;
}

/** 计算若干静音区间在 [0, duration] 上的补集，即保留区间 */
export function complement(silences: SilenceRange[], duration: number): SilenceRange[] {
  const sorted = [...silences].sort((a, b) => a.start - b.start);
  const kept: SilenceRange[] = [];
  let cursor = 0;
  for (const s of sorted) {
    const start = Math.max(0, s.start);
    const end = Math.min(duration, s.end);
    if (end <= cursor) continue; // 整段已被更早的静音覆盖
    if (start > cursor + EPS) kept.push({ start: cursor, end: start });
    cursor = end;
  }
  if (cursor < duration - EPS) kept.push({ start: cursor, end: duration });
  return kept;
}

export function rangeDuration(ranges: SilenceRange[]): number {
  return ranges.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0);
}

/** 合并相交或端点相接的区间，输出不相交的升序区间 */
export function mergeRanges(ranges: SilenceRange[]): SilenceRange[] {
  const sorted = ranges
    .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end - r.start > EPS)
    .map(r => ({ start: Math.max(0, r.start), end: r.end }))
    .sort((a, b) => a.start - b.start);
  const out: SilenceRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + EPS) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * 校验一组静音区间能否用于裁切。
 * 所有坐标均以原始录音时间轴 [0, bounds.duration] 为准；
 * 再次裁切时传入的同样是原始时长，区间与既有静音重叠会被 OVERLAP 拒绝。
 * @param input 用户填写的区间（可能是字符串）
 * @param bounds 原始录音的时间范围
 */
export function checkTrim(
  input: Array<{ start: number | string; end: number | string }>,
  bounds: TrimBounds,
): TrimCheckResult {
  const fail = (error: TrimError): TrimCheckResult => ({
    ok: false,
    error,
    normalized: [],
    kept: [],
    keptDuration: 0,
  });

  const duration = bounds.duration;
  if (input.length === 0) return fail('EMPTY');

  const ranges = toRanges(input);
  if (!ranges) return fail('BAD_SHAPE');

  for (const r of ranges) {
    if (r.end < r.start - EPS) return fail('REVERSED');
    if (r.start < -EPS || r.end > duration + EPS) return fail('OUT_OF_BOUNDS');
  }

  // 归一化并裁到边界内，再按起点排序检测重叠
  const normalized = ranges
    .map(r => ({ start: Math.max(0, r.start), end: Math.min(duration, r.end) }))
    .filter(r => r.end - r.start > EPS)
    .sort((a, b) => a.start - b.start);

  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].start < normalized[i - 1].end - EPS) return fail('OVERLAP');
  }

  const kept = complement(normalized, duration);
  const keptDuration = rangeDuration(kept);

  if (kept.length === 0 || keptDuration <= EPS) return fail('ALL_COVERED');
  if (keptDuration + EPS < MIN_KEEP_SECONDS) return fail('TOO_SHORT');

  return { ok: true, normalized, kept, keptDuration };
}

/** 时间格式：8.4 -> 0:08.4 */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const whole = Math.floor(rest);
  const tenth = Math.round((rest - whole) * 10);
  if (tenth === 10) return `${m}:${String(whole + 1).padStart(2, '0')}.0`;
  return `${m}:${String(whole).padStart(2, '0')}.${tenth}`;
}
