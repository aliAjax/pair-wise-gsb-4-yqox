// 静音裁切 · 页面层：只读订阅 store，所有规则判定均来自 logic，不在组件内重写
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  History,
  Mic,
  Plus,
  Scissors,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { fmtTime, MIN_CROP_SECONDS, rangeLen } from './logic';
import { cropStore, useCropStore } from './store';
import type { CropVersion, Recording, SecondsRange } from './types';

interface DraftRow { id: string; start: string; end: string }
interface Feedback { kind: 'error' | 'ok'; text: string }

const newRow = (): DraftRow => ({ id: Math.random().toString(36).slice(2), start: '', end: '' });

const stampLabel = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const parseNum = (s: string): number => Number(s.trim());

/** 时间轴：灰=静音，绿=有效音段，描边覆盖层=保留区间 */
function Timeline({
  duration,
  version,
  height = 34,
}: {
  duration: number;
  version: CropVersion;
  height?: number;
}) {
  const pct = (r: SecondsRange) => ({
    left: `${(r.start / duration) * 100}%`,
    width: `${Math.max(0, ((r.end - r.start) / duration) * 100)}%`,
  });
  return (
    <div className="crop-track" style={{ height }}>
      {version.voiced.map((v, i) => (
        <i key={`v${i}`} className="crop-seg voiced" style={pct(v)} />
      ))}
      {version.silences.map((s, i) => (
        <i key={`s${i}`} className="crop-seg silence" style={pct(s)} />
      ))}
      {version.kept.map((k, i) => (
        <i key={`k${i}`} className="crop-seg kept" style={pct(k)} />
      ))}
    </div>
  );
}

function RangeList({ ranges, tone = 'plain' }: { ranges: SecondsRange[]; tone?: 'plain' | 'kept' }) {
  if (ranges.length === 0) return <span className="crop-empty-text">无</span>;
  return (
    <div className="range-tags">
      {ranges.map((r, i) => (
        <span key={i} className={tone === 'kept' ? 'range-tag kept' : 'range-tag'}>
          {r.start.toFixed(1)}s – {r.end.toFixed(1)}s
          <em>{fmtTime(rangeLen(r))}</em>
        </span>
      ))}
    </div>
  );
}

const toDraft = (r: Recording | undefined): DraftRow[] =>
  r
    ? r.versions[r.versions.length - 1].kept.map((k) => ({
        id: newRow().id,
        start: String(k.start),
        end: String(k.end),
      }))
    : [newRow()];

export default function CropView() {
  const data = useCropStore();
  const { recordings, pending } = data;

  const [selectedId, setSelectedId] = useState<string | null>(recordings[0]?.id ?? null);
  const [inspectVersion, setInspectVersion] = useState<number | null>(null);
  const [draft, setDraft] = useState<DraftRow[]>(() => toDraft(recordings[0]));
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [showRegister, setShowRegister] = useState(false);

  const selected: Recording | undefined =
    recordings.find((r) => r.id === selectedId) ?? recordings[0] ?? undefined;

  const latestVersion = selected ? selected.versions[selected.versions.length - 1] : null;
  const shownVersionIndex =
    inspectVersion !== null && selected && inspectVersion < selected.versions.length
      ? inspectVersion
      : selected ? selected.versions.length - 1 : null;
  const shownVersion = selected && shownVersionIndex !== null ? selected.versions[shownVersionIndex] : null;
  const viewingLatest = shownVersionIndex !== null && selected && shownVersionIndex === selected.versions.length - 1;

  const phrasePending = selected
    ? Object.values(pending).find((p) => p.phraseId === selected.phraseId)
    : undefined;
  const pendingOnSource = phrasePending && selected && phrasePending.sourceRecordingId === selected.id;

  const selectRecording = (id: string) => {
    const rec = recordings.find((r) => r.id === id);
    setSelectedId(id);
    setInspectVersion(null);
    setFeedback(null);
    setDraft(toDraft(rec));
  };

  const updateRow = (id: string, key: 'start' | 'end', value: string) =>
    setDraft((rows) => rows.map((r) => (r.id === id ? { ...r, [key]: value } : r)));

  const parseDraft = (): SecondsRange[] | null => {
    const ranges: SecondsRange[] = [];
    for (const row of draft) {
      if (row.start.trim() === '' && row.end.trim() === '') continue;
      const start = parseNum(row.start);
      const end = parseNum(row.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      ranges.push({ start, end });
    }
    return ranges;
  };

  const onPreview = () => {
    if (!selected) return;
    const kept = parseDraft();
    if (!kept) {
      setFeedback({ kind: 'error', text: '请填写数字格式的起止秒数（空行将被忽略）' });
      return; // 拒绝时不清空、不修改任何输入，保留原值
    }
    const result = cropStore.submit({
      phraseId: selected.phraseId,
      recordingId: selected.id,
      kept,
      createdAt: new Date().toISOString(),
    });
    if (!result.ok) {
      // 拒绝预览：保留输入原值与既有数据
      setFeedback({ kind: 'error', text: result.preview.detail });
    } else {
      setFeedback({
        kind: 'ok',
        text: `预览已生成：裁切后 ${result.preview.croppedDuration.toFixed(1)} 秒，确认后才会生成新版本`,
      });
    }
  };

  const onConfirm = () => {
    if (!phrasePending) return;
    const targetId = phrasePending.sourceRecordingId;
    const result = cropStore.confirm(phrasePending.id);
    if (result.ok) {
      setSelectedId(targetId);
      setInspectVersion(null);
      setDraft(toDraft(cropStore.getState().recordings.find((r) => r.id === targetId)));
      setFeedback({ kind: 'ok', text: `已确认并生成 v${result.version}，旧版本仍可在版本记录中查看` });
    } else {
      setFeedback({ kind: 'error', text: result.error });
    }
  };

  const onUndo = () => {
    if (!selected) return;
    const result = cropStore.undo(selected.id);
    if (result.ok) {
      setInspectVersion(null);
      setDraft(toDraft(cropStore.getState().recordings.find((r) => r.id === selected.id)));
      setFeedback({ kind: 'ok', text: '已撤销最近一次确认裁切，回到上一版本' });
    } else {
      setFeedback({ kind: 'error', text: result.error });
    }
  };

  return (
    <div className="crop-view">
      <header className="crop-head">
        <div>
          <p className="eyebrow">SILENCE CROP</p>
          <h1>静音裁切</h1>
          <p className="crop-sub">登记每条录音的句子、原始时长与静音区间；预览校验通过后确认，生成可追溯的新版本。</p>
        </div>
        <button className="primary" onClick={() => setShowRegister(true)}>
          <Plus size={16} /> 登记录音
        </button>
      </header>

      <div className="content-grid">
        {/* 左：录音列表 */}
        <section className="library">
          <div className="section-head">
            <div>
              <h2>录音登记</h2>
              <p>{recordings.length} 条录音 · {Object.keys(pending).length} 个待确认裁切</p>
            </div>
          </div>
          <div className="phrase-list">
            {recordings.map((r) => {
              const latest = r.versions[r.versions.length - 1];
              const p = Object.values(pending).find((x) => x.phraseId === r.phraseId);
              return (
                <button
                  key={r.id}
                  onClick={() => selectRecording(r.id)}
                  className={selected?.id === r.id ? 'phrase selected' : 'phrase'}
                >
                  <div className="phrase-icon"><Scissors size={15} /></div>
                  <div className="phrase-copy">
                    <strong>{r.phrase}</strong>
                    <span>原始 {fmtTime(latest.sourceDuration)} · 当前 v{latest.version}（{fmtTime(latest.croppedDuration)}）</span>
                    <div className="phrase-meta">
                      <i>{r.versions.length} 个版本</i>
                      <i>{latest.silences.length} 段静音</i>
                      {p && <small className="pending-dot">待确认</small>}
                    </div>
                  </div>
                </button>
              );
            })}
            {recordings.length === 0 && <div className="empty">还没有录音，点击右上角“登记录音”开始</div>}
          </div>
        </section>

        {/* 右：裁切工作台 */}
        <section className="practice crop-workbench">
          {!selected || !latestVersion || !shownVersion ? (
            <div className="empty">选择一条录音查看静音区间与版本记录</div>
          ) : (
            <>
              <div className="practice-head">
                <div>
                  <span className="label">CURRENT RECORDING</span>
                  <h2>{selected.phrase}</h2>
                </div>
                <button className="icon-btn" title="删除整条录音" onClick={() => {
                  cropStore.remove(selected.id);
                  setFeedback(null);
                }}><Trash2 size={16} /></button>
              </div>

              {/* 四项登记信息 */}
              <div className="crop-meta-card">
                <div className="crop-meta-row">
                  <span><Mic size={13} /> 登记句子</span>
                  <strong>{selected.phrase}</strong>
                </div>
                <div className="crop-meta-row">
                  <span><Clock3 size={13} /> 原始时长</span>
                  <strong>{latestVersion.sourceDuration.toFixed(1)} 秒（{fmtTime(latestVersion.sourceDuration)}）</strong>
                </div>
                <div className="crop-meta-block">
                  <span>静音区间（{latestVersion.silences.length} 段）</span>
                  <RangeList ranges={latestVersion.silences} />
                </div>
                <div className="crop-meta-block">
                  <span>保留区间 · 当前 v{latestVersion.version}（合计 {fmtTime(latestVersion.croppedDuration)}）</span>
                  <RangeList ranges={latestVersion.kept} tone="kept" />
                </div>
                <div className="crop-timeline-wrap">
                  <Timeline duration={latestVersion.sourceDuration} version={latestVersion} />
                  <div className="crop-legend">
                    <span><i className="dot voiced" />有效音段</span>
                    <span><i className="dot silence" />静音</span>
                    <span><i className="dot kept" />保留区间</span>
                  </div>
                </div>
              </div>

              {/* 版本记录：旧录音仍可查 */}
              <div className="crop-versions">
                <div className="crop-versions-head"><History size={14} /> 版本记录</div>
                <div className="version-chips">
                  {selected.versions.map((v) => (
                    <button
                      key={v.version}
                      className={v.version === shownVersion.version ? 'version-chip active' : 'version-chip'}
                      onClick={() => setInspectVersion(v.version)}
                    >
                      {v.version === 0 ? '原始' : `v${v.version}`}
                      <em>{fmtTime(v.croppedDuration)}</em>
                    </button>
                  ))}
                </div>
                <div className="version-detail">
                  <div className="version-detail-head">
                    <strong>{shownVersion.version === 0 ? '原始录音' : `裁切版本 v${shownVersion.version}`}</strong>
                    <span>{stampLabel(shownVersion.confirmedAt)}</span>
                  </div>
                  <Timeline duration={shownVersion.sourceDuration} version={shownVersion} height={28} />
                  <div className="version-facts">
                    <span>裁切后时长 <b>{shownVersion.croppedDuration.toFixed(1)} 秒</b></span>
                    <span>有效音段 {shownVersion.voiced.length} 段</span>
                  </div>
                  <RangeList ranges={shownVersion.kept} tone="kept" />
                  {!viewingLatest && <p className="viewing-hint">正在查看历史版本（只读），切到最新版本即可继续裁切</p>}
                </div>
                <div className="undo-row">
                  <button
                    className="secondary"
                    disabled={selected.versions.length <= 1 || !!phrasePending}
                    onClick={onUndo}
                    title={phrasePending ? '存在待确认裁切，请先处理' : '仅撤销最近一次已确认裁切'}
                  >
                    <Undo2 size={14} /> 撤销最近裁切
                  </button>
                  <small>撤销只回到最近一次已确认版本{phrasePending ? '；有待确认项时不可撤销' : ''}</small>
                </div>
              </div>

              {/* 待确认裁切 */}
              {phrasePending && (
                <div className="pending-card">
                  <div className="pending-head">
                    <span className="pending-badge"><Clock3 size={13} /> 待确认裁切</span>
                    <small>
                      基于 {phrasePending.sourceVersion === 0 ? '原始录音' : `v${phrasePending.sourceVersion}`} ·
                      裁切后 {phrasePending.croppedDuration.toFixed(1)} 秒
                      {!pendingOnSource && '（同一句子的另一条录音）'}
                    </small>
                  </div>
                  <RangeList ranges={phrasePending.kept} tone="kept" />
                  <div className="pending-actions">
                    <button className="primary" onClick={onConfirm}><Check size={15} /> 确认裁切（生成新版本）</button>
                    <button className="secondary" onClick={() => { cropStore.cancel(phrasePending.id); setFeedback(null); }}>
                      <X size={14} /> 放弃
                    </button>
                  </div>
                </div>
              )}

              {/* 待确认裁切在同一句子的另一条录音上：本录音暂不能新建裁切 */}
              {phrasePending && !pendingOnSource && viewingLatest && (
                <div className="crop-feedback ok">
                  <Clock3 size={14} />
                  同一句子已有一个待确认裁切（基于另一条录音），请先在上方确认或放弃，再对本录音裁切。
                </div>
              )}

              {/* 预览编辑器：仅最新版本且没有“他处待确认”时可编辑（同句只允许一个待确认） */}
              {viewingLatest && (!phrasePending || pendingOnSource) && (
                <div className="crop-editor">
                  {pendingOnSource && (
                    <p className="crop-rules" style={{ color: '#0f8a72' }}>
                      当前已有一个基于本录音的待确认裁切；再次预览将替换它，确认后才生成新版本。
                    </p>
                  )}
                  <div className="crop-editor-head">
                    <h3>拟保留区间</h3>
                    <button className="ghost" onClick={() => setDraft([...draft, newRow()])}><Plus size={13} /> 添加区间</button>
                  </div>
                  <p className="crop-rules">
                    规则：区间须落在 0–{latestVersion.sourceDuration.toFixed(1)} 秒内且互不重叠；裁切后至少 {MIN_CROP_SECONDS} 秒；不得覆盖全部有效音段。不符合则拒绝预览并保留原值。
                  </p>
                  <div className="draft-rows">
                    {draft.map((row, i) => (
                      <div key={row.id} className="draft-row">
                        <span className="draft-idx">#{i + 1}</span>
                        <input
                          value={row.start}
                          onChange={(e) => updateRow(row.id, 'start', e.target.value)}
                          placeholder="起 s"
                          inputMode="decimal"
                        />
                        <i>–</i>
                        <input
                          value={row.end}
                          onChange={(e) => updateRow(row.id, 'end', e.target.value)}
                          placeholder="止 s"
                          inputMode="decimal"
                        />
                        <button
                          className="icon-btn"
                          onClick={() => setDraft(draft.length === 1 ? [newRow()] : draft.filter((x) => x.id !== row.id))}
                          title="删除区间"
                        ><Trash2 size={14} /></button>
                      </div>
                    ))}
                  </div>
                  <div className="pending-actions">
                    <button className="primary" onClick={onPreview}><Scissors size={14} /> 预览校验</button>
                    <button className="secondary" onClick={() => {
                      setDraft(toDraft(selected));
                      setFeedback(null);
                    }}>还原当前版本</button>
                  </div>
                </div>
              )}

              {feedback && (
                <div className={feedback.kind === 'error' ? 'crop-feedback error' : 'crop-feedback ok'}>
                  {feedback.kind === 'error' ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
                  {feedback.text}
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {showRegister && (
        <RegisterModal
          recordings={recordings}
          onClose={() => setShowRegister(false)}
          onRegistered={(id) => {
            setShowRegister(false);
            selectRecording(id);
          }}
        />
      )}
    </div>
  );
}

/* ---------- 登记录音弹窗 ---------- */

function RegisterModal({
  recordings,
  onClose,
  onRegistered,
}: {
  recordings: Recording[];
  onClose: () => void;
  onRegistered: (id: string) => void;
}) {
  const knownPhrases = useMemo(() => {
    const map = new Map<number, string>();
    recordings.forEach((r) => map.set(r.phraseId, r.phrase));
    return Array.from(map.entries());
  }, [recordings]);

  const [phraseChoice, setPhraseChoice] = useState(knownPhrases[0] ? String(knownPhrases[0][0]) : 'custom');
  const [customPhrase, setCustomPhrase] = useState('');
  const [duration, setDuration] = useState('');
  const [silenceRows, setSilenceRows] = useState<DraftRow[]>([newRow(), newRow()]);
  const [error, setError] = useState('');

  const submit = () => {
    const phrase =
      phraseChoice === 'custom' ? customPhrase.trim() : knownPhrases.find(([id]) => String(id) === phraseChoice)?.[1] ?? '';
    if (!phrase) { setError('请填写登记句子'); return; }
    const dur = parseNum(duration);
    if (!Number.isFinite(dur) || dur <= 0) { setError('原始时长需为大于 0 的秒数'); return; }
    const silences: SecondsRange[] = [];
    for (const row of silenceRows) {
      if (row.start.trim() === '' && row.end.trim() === '') continue;
      const s = parseNum(row.start);
      const e = parseNum(row.end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e > dur || s >= e) {
        setError(`静音区间需落在 0–${dur.toFixed(1)} 秒内，且起点小于终点`);
        return;
      }
      silences.push({ start: s, end: e });
    }
    const phraseId = phraseChoice === 'custom' ? Date.now() : Number(phraseChoice);
    cropStore.register({ phraseId, phrase, duration: dur, silences, createdAt: new Date().toISOString() });
    const rec = cropStore.getState().recordings[0];
    onRegistered(rec.id);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal crop-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>登记录音</h2>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>
        <label>
          登记句子
          <select value={phraseChoice} onChange={(e) => setPhraseChoice(e.target.value)}>
            {knownPhrases.map(([id, text]) => (
              <option key={id} value={String(id)}>{text}</option>
            ))}
            <option value="custom">自定义新句子…</option>
          </select>
          {phraseChoice === 'custom' && (
            <textarea value={customPhrase} onChange={(e) => setCustomPhrase(e.target.value)} placeholder="输入这次朗读的句子" />
          )}
        </label>
        <label>
          原始时长（秒）
          <input value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="例如 8.4" inputMode="decimal" />
        </label>
        <div className="register-silences">
          <div className="crop-editor-head"><h3>静音区间（秒，可留空行）</h3>
            <button className="ghost" onClick={() => setSilenceRows([...silenceRows, newRow()])}><Plus size={13} /> 添加</button>
          </div>
          {silenceRows.map((row) => (
            <div key={row.id} className="draft-row">
              <input value={row.start} onChange={(e) => setSilenceRows(silenceRows.map((x) => x.id === row.id ? { ...x, start: e.target.value } : x))} placeholder="起 s" inputMode="decimal" />
              <i>–</i>
              <input value={row.end} onChange={(e) => setSilenceRows(silenceRows.map((x) => x.id === row.id ? { ...x, end: e.target.value } : x))} placeholder="止 s" inputMode="decimal" />
            </div>
          ))}
        </div>
        {error && <div className="crop-feedback error"><AlertTriangle size={14} />{error}</div>}
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>取消</button>
          <button className="primary" onClick={submit}>登记</button>
        </div>
      </div>
    </div>
  );
}
