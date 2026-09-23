import { useMemo, useState } from 'react';
import { Check, ChevronLeft, Clock3, Eye, History, Plus, Scissors, Trash2, Undo2, X } from 'lucide-react';
import type { Recording, TrimStore } from './types';
import { checkTrim, ERROR_TEXT, formatTime, MIN_KEEP_SECONDS } from './validation';
import { confirmTrim, discardDraft, getDraft, saveDraft, undoLastConfirm } from './storage';

interface TrimPanelProps {
  store: TrimStore;
  onChange: (store: TrimStore) => void;
  onClose: () => void;
}

interface RowDraft {
  start: string;
  end: string;
}

type Notice = { kind: 'error' | 'ok'; text: string } | null;

function toRowDraft(ranges: Array<{ start: number; end: number }>): RowDraft[] {
  return ranges.map(r => ({ start: String(round1(r.start)), end: String(round1(r.end)) }));
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function dateLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 区间时间轴：静音段与保留段按比例铺在 0..duration 上 */
function Timeline({ recording }: { recording: Recording }) {
  const v = recording.versions[0];
  return (
    <div className="trim-track" title={`原始时长 ${formatTime(recording.originalDuration)}`}>
      {v.kept.map((k, i) => (
        <i
          key={i}
          className="seg kept"
          style={{ left: `${(k.start / recording.originalDuration) * 100}%`, width: `${((k.end - k.start) / recording.originalDuration) * 100}%` }}
        />
      ))}
      {v.silences.map((s, i) => (
        <i
          key={`s${i}`}
          className="seg mute"
          style={{ left: `${(s.start / recording.originalDuration) * 100}%`, width: `${((s.end - s.start) / recording.originalDuration) * 100}%` }}
        />
      ))}
    </div>
  );
}

function PreviewTrack({ kept, silences, duration }: { kept: Array<{ start: number; end: number }>; silences: Array<{ start: number; end: number }>; duration: number }) {
  return (
    <div className="trim-track preview">
      {kept.map((k, i) => (
        <i key={i} className="seg kept" style={{ left: `${(k.start / duration) * 100}%`, width: `${((k.end - k.start) / duration) * 100}%` }} />
      ))}
      {silences.map((s, i) => (
        <i key={`s${i}`} className="seg mute" style={{ left: `${(s.start / duration) * 100}%`, width: `${((s.end - s.start) / duration) * 100}%` }} />
      ))}
    </div>
  );
}

export default function TrimPanel({ store, onChange, onClose }: TrimPanelProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showHistoryFor, setShowHistoryFor] = useState<number | null>(null);
  const [rows, setRows] = useState<RowDraft[]>([{ start: '', end: '' }]);
  const [notice, setNotice] = useState<Notice>(null);

  const selected = store.recordings.find(r => r.id === selectedId) ?? null;
  const historyRec = store.recordings.find(r => r.id === showHistoryFor) ?? null;

  const draftOf = (r: Recording) => getDraft(store, r.id);
  const current = selected?.versions[0];

  // 坐标全部以原始录音时间轴 [0, originalDuration] 为准
  const check = useMemo(() => {
    if (!selected) return null;
    return checkTrim(rows, { duration: selected.originalDuration });
  }, [rows, selected]);
  const canConfirm = !!check?.ok;

  const openRecording = (r: Recording) => {
    setSelectedId(r.id);
    setShowHistoryFor(null);
    setNotice(null);
    const d = draftOf(r);
    setRows(d ? toRowDraft(d.silences) : toRowDraft(r.versions[0].silences));
  };

  const backToList = () => {
    setSelectedId(null);
    setShowHistoryFor(null);
    setNotice(null);
  };

  const updateRow = (i: number, key: keyof RowDraft, value: string) => {
    setNotice(null);
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  };
  const addRow = () => setRows(rs => [...rs, { start: '', end: '' }]);
  const removeRow = (i: number) => setRows(rs => (rs.length === 1 ? [{ start: '', end: '' }] : rs.filter((_, idx) => idx !== i)));

  // 预览：校验通过才把静音区间登记为该录音的待确认裁切；失败则拒绝并保留原值
  const preview = () => {
    if (!selected || !check) return;
    if (!check.ok) {
      setNotice({ kind: 'error', text: `已拒绝预览：${ERROR_TEXT[check.error!]}，原编辑值已保留` });
      return;
    }
    const res = saveDraft(store, selected.id, selected.phraseId, check.normalized);
    if (res.error) {
      const other = store.recordings.find(r => r.id === res.conflictRecordingId);
      setNotice({ kind: 'error', text: `同一句子已存在待确认裁切${other ? `（${formatTime(other.originalDuration)} 的录音）` : ''}，请先确认或丢弃` });
      return;
    }
    onChange(res.store);
    setRows(toRowDraft(check.normalized));
    setNotice({ kind: 'ok', text: `预览已生成：保留 ${formatTime(check.keptDuration)}，共 ${check.kept.length} 段。确认后才会生成新版本` });
  };

  const confirm = () => {
    if (!selected || !check) return;
    const res = confirmTrim(store, selected.id, rows);
    if (res.error) {
      setNotice({ kind: 'error', text: `无法确认：${ERROR_TEXT[res.error]}，原值已保留` });
      return;
    }
    onChange(res.store);
    const fresh = res.store.recordings.find(r => r.id === selected.id)!;
    setRows(toRowDraft(fresh.versions[0].silences));
    setNotice({ kind: 'ok', text: `已确认，生成第 ${fresh.versions[0].version} 版；历史录音仍可在版本记录中查看` });
  };

  const discard = () => {
    if (!selected) return;
    onChange(discardDraft(store, selected.id));
    setRows(toRowDraft(selected.versions[0].silences));
    setNotice({ kind: 'ok', text: '待确认裁切已丢弃，恢复为当前版本的静音区间' });
  };

  const undo = () => {
    if (!selected || selected.versions.length < 2) return;
    const prev = selected.versions[1];
    onChange(undoLastConfirm(store, selected.id));
    setRows(toRowDraft(prev.silences));
    setNotice({ kind: 'ok', text: `已撤销最近一次裁切，回到第 ${prev.version} 版` });
  };

  return (
    <aside className="trim-panel">
      <div className="trim-head">
        <div className="trim-title">
          <span className="trim-mark"><Scissors size={16} /></span>
          <div>
            <strong>静音裁切</strong>
            <span>{selected || historyRec ? '裁切编辑' : `${store.recordings.length} 条录音 · ${store.drafts.length} 个待确认`}</span>
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} title="收起侧栏"><X size={18} /></button>
      </div>

      {/* 列表视图 */}
      {!selected && !historyRec && (
        <div className="trim-body">
          {store.recordings.length === 0 && <div className="empty">还没有录音，先在练习区录一条吧</div>}
          {store.recordings.map(r => {
            const d = draftOf(r);
            const v = r.versions[0];
            return (
              <div key={r.id} className="rec-card">
                <button className="rec-main" onClick={() => openRecording(r)}>
                  <div className="rec-sentence">{r.phraseText}</div>
                  <div className="rec-meta">
                    <span><Clock3 size={12} /> 原始 {formatTime(r.originalDuration)}</span>
                    <span>现保留 {formatTime(v.duration)}</span>
                    <span>v{r.versions.length > 1 ? r.versions[0].version : 1}</span>
                    {r.versions.length > 1 && <em className="ver-count">{r.versions.length} 版</em>}
                  </div>
                  <Timeline recording={r} />
                </button>
                <div className="rec-foot">
                  {d ? (
                    <button className="chip-badge warn" onClick={() => openRecording(r)}>
                      <Eye size={12} /> 待确认裁切 · {d.silences.length} 段静音
                    </button>
                  ) : (
                    <span className="chip-badge plain">无待确认项</span>
                  )}
                  <button className="link-btn" onClick={() => { setShowHistoryFor(r.id); setNotice(null); }} disabled={r.versions.length < 2}>
                    <History size={13} /> 版本记录
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 版本记录视图：旧录音仍可查 */}
      {!selected && historyRec && (
        <div className="trim-body">
          <button className="back-btn" onClick={backToList}><ChevronLeft size={15} /> 返回录音列表</button>
          <h3 className="subhead">版本记录</h3>
          <p className="subsentence">{historyRec.phraseText}</p>
          {historyRec.versions.map(v => (
            <div key={v.version} className={`ver-card ${v.version === historyRec.versions[0].version ? 'current' : ''}`}>
              <div className="ver-top">
                <strong>第 {v.version} 版{v.version === 1 && ' · 原始录音'}</strong>
                {v.version === historyRec.versions[0].version ? <span className="chip-badge ok">当前版本</span> : <span className="chip-badge plain">历史版本</span>}
              </div>
              <div className="ver-meta">
                <span>保留 {formatTime(v.duration)}</span>
                <span>静音 {v.silences.length} 段</span>
                <span>{dateLabel(v.confirmedAt)}</span>
              </div>
              <div className="trim-track static">
                {v.kept.map((k, i) => (
                  <i key={i} className="seg kept" style={{ left: `${(k.start / historyRec.originalDuration) * 100}%`, width: `${((k.end - k.start) / historyRec.originalDuration) * 100}%` }} />
                ))}
                {v.silences.map((s, i) => (
                  <i key={`s${i}`} className="seg mute" style={{ left: `${(s.start / historyRec.originalDuration) * 100}%`, width: `${((s.end - s.start) / historyRec.originalDuration) * 100}%` }} />
                ))}
              </div>
              <div className="range-lines">
                {v.silences.length === 0 && <span>无静音标记</span>}
                {v.silences.map((s, i) => (
                  <span key={i}>{formatTime(s.start)} – {formatTime(s.end)}</span>
                ))}
              </div>
            </div>
          ))}
          <div className="tip-note">旧版本只读保留，可随时查阅；撤销仅回到最近一次已确认版本。</div>
        </div>
      )}

      {/* 编辑视图 */}
      {selected && current && (
        <div className="trim-body">
          <button className="back-btn" onClick={backToList}><ChevronLeft size={15} /> 返回录音列表</button>
          <div className="edit-summary">
            <p className="subsentence">{selected.phraseText}</p>
            <div className="ver-meta">
              <span>原始 {formatTime(selected.originalDuration)}</span>
              <span>当前 v{current.version} · 保留 {formatTime(current.duration)}</span>
              <span>{dateLabel(selected.recordedAt)} 录制</span>
            </div>
            <Timeline recording={selected} />
            <div className="track-scale"><span>0:00.0</span><span>{formatTime(selected.originalDuration)}</span></div>
          </div>

          <h3 className="subhead">静音区间（秒）</h3>
          <div className="range-editor">
            <div className="range-row range-head"><span>起</span><span>止</span><span /></div>
            {rows.map((r, i) => (
              <div className="range-row" key={i}>
                <input value={r.start} inputMode="decimal" placeholder="0.0" onChange={e => updateRow(i, 'start', e.target.value)} />
                <input value={r.end} inputMode="decimal" placeholder="0.0" onChange={e => updateRow(i, 'end', e.target.value)} />
                <button className="icon-btn" onClick={() => removeRow(i)} title="删除该区间"><Trash2 size={14} /></button>
              </div>
            ))}
            <button className="add-range" onClick={addRow}><Plus size={13} /> 添加静音区间</button>
          </div>

          {check?.ok && (
            <div className="preview-box">
              <div className="preview-head"><Eye size={13} /> 裁切预览
                <span className="chip-badge ok">保留 {formatTime(check.keptDuration)} · {check.kept.length} 段</span>
              </div>
              <PreviewTrack kept={check.kept} silences={check.normalized} duration={selected.originalDuration} />
              <div className="track-scale"><span>0:00.0</span><span>{formatTime(selected.originalDuration)}</span></div>
              <div className="range-lines">
                {check.normalized.map((s, i) => (
                  <span key={i} className="mute-tag">静音 {formatTime(s.start)}–{formatTime(s.end)}</span>
                ))}
              </div>
            </div>
          )}

          {notice && <div className={`trim-notice ${notice.kind}`}>{notice.text}</div>}

          <div className="rule-hint">
            区间不可越界或重叠；裁切后至少保留 {MIN_KEEP_SECONDS} 秒，且不能覆盖全部有效音段，否则拒绝预览。
          </div>

          <div className="edit-actions">
            <button className="secondary" onClick={preview}><Eye size={14} /> 生成预览</button>
            <button className="primary" onClick={confirm} disabled={!canConfirm}><Check size={14} /> 确认裁切</button>
          </div>
          <div className="edit-actions sub">
            <button className="link-btn" onClick={discard} disabled={!draftOf(selected)}><Trash2 size={13} /> 丢弃待确认项</button>
            <button className="link-btn" onClick={undo} disabled={selected.versions.length < 2 || !!draftOf(selected)} title={draftOf(selected) ? '存在待确认裁切时不能撤销' : '回到最近一次已确认版本'}>
              <Undo2 size={13} /> 撤销最近确认
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
