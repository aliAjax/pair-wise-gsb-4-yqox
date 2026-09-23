// 静音裁切 · 数据模型（与判定、存储、页面均无关的纯结构定义）

/** 半开区间 [start, end)，单位秒 */
export interface SecondsRange {
  start: number;
  end: number;
}

/** 一次录音登记的句子信息与音段标注 */
export interface RecordingEntry {
  id: string;
  /** 登记句子 */
  phrase: string;
  /** 原始时长（秒） */
  duration: number;
  /** 静音区间（由检测/标注得到，互不重叠） */
  silences: SecondsRange[];
  /** 有效音段（静音之外的有声区间，由静音补集推导） */
  voiced: SecondsRange[];
  /** 登记时间，仅用于展示 */
  createdAt: string;
}

/** 一次已确认裁切留下的不可变版本 */
export interface CropVersion {
  /** 版本号，从 1 开始 */
  version: number;
  /** 裁切时作为来源的录音 id（始终指向某条已确认录音版本） */
  sourceRecordingId: string;
  /** 静音区间（沿用来源录音标注） */
  silences: SecondsRange[];
  /** 有效音段（沿用来源录音标注） */
  voiced: SecondsRange[];
  /** 原始时长（秒，沿用来源录音） */
  sourceDuration: number;
  /** 保留区间（落在时间轴上、半开区间） */
  kept: SecondsRange[];
  /** 裁切后时长 = 保留区间长度之和 */
  croppedDuration: number;
  confirmedAt: string;
}

/** 某句子的一条录音：初版为原始录音，之后每个确认裁切追加一个版本 */
export interface Recording {
  id: string;
  phraseId: number;
  phrase: string;
  createdAt: string;
  /** versions[0] 为原始录音；其后为逐次确认生成的裁切版本 */
  versions: CropVersion[];
}

/** 待确认裁切（同一句子至多一个） */
export interface PendingCrop {
  id: string;
  phraseId: number;
  /** 基于哪个录音版本进行裁切 */
  sourceRecordingId: string;
  sourceVersion: number;
  kept: SecondsRange[];
  /** 提交预览时算出的裁切后时长 */
  croppedDuration: number;
  createdAt: string;
}

/** 拒绝预览的原因码 */
export type RejectReason =
  | 'out-of-bounds'
  | 'overlap'
  | 'too-short'
  | 'covers-all-voiced';

/** 预览校验结果 */
export type PreviewResult =
  | { ok: true; kept: SecondsRange[]; croppedDuration: number; coveredVoiced: number }
  | { ok: false; reason: RejectReason; detail: string };

/** 持久化结构 */
export interface CropStoreData {
  recordings: Recording[];
  pending: Record<string, PendingCrop>;
}
