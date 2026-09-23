// 静音裁切领域模型：录音、版本、待确认裁切草稿

/** 一条静音区间，端点单位为秒；起于 start，止于 end（start <= end） */
export interface SilenceRange {
  start: number;
  end: number;
}

/**
 * 一次裁切结果。versions[0] 是当前生效版本，之后按确认顺序排列历史版本；
 * 最早的原始录音在数组末尾，保证“旧录音仍可查”。
 */
export interface TrimVersion {
  /** 该版本的静音区间，按起点升序 */
  silences: SilenceRange[];
  /** 该版本保留区间，按起点升序 */
  kept: SilenceRange[];
  /** 裁切后保留总时长（秒），等于 kept 各段之和 */
  duration: number;
  /** 版本序号，原始录音为 1，每确认一次 +1 */
  version: number;
  /** 确认时间戳（原始录音为创建时间戳） */
  confirmedAt: number;
}

/** 每条录音的登记信息 */
export interface Recording {
  id: number;
  /** 登记句子 */
  phraseId: number;
  phraseText: string;
  /** 原始时长（秒） */
  originalDuration: number;
  /** 录制时间戳 */
  recordedAt: number;
  /** 已确认版本，versions[0] 为当前生效版本 */
  versions: TrimVersion[];
}

/** 待确认裁切（预览），每条录音至多一个 */
export interface TrimDraft {
  /** 关联录音 id */
  recordingId: number;
  /** 关联句子 id，用于“同一句子只能有一个待确认裁切”的约束 */
  phraseId: number;
  /** 正在编辑的静音区间，按起点升序 */
  silences: SilenceRange[];
}

/** 持久化根结构 */
export interface TrimStore {
  recordings: Recording[];
  drafts: TrimDraft[];
  /** 录音自增 id */
  nextId: number;
}
