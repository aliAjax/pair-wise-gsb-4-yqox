# 声线练习室 Pronunciation Lab

纯前端语音练习应用（React + TypeScript + Vite，无额外运行时依赖）。

- `npm run dev` 本地开发，`npm run build` 类型检查并打包。
- 练习库：登记练习句子、计时录音，进度保存在 `localStorage`。
- **静音裁切侧栏**（`src/trim/`）：
  - `types.ts` 数据模型：录音登记（句子、原始时长、静音/保留区间）、版本、待确认裁切；
  - `validation.ts` 纯函数判定：区间越界、重叠、反向、裁切后不足 3 秒、覆盖全部有效音段一律拒绝；
  - `storage.ts` 状态流转与 `localStorage` 持久化（含损坏数据修复）：每句至多一个待确认裁切，确认生成新版本且旧版本保留可查，撤销只回到最近已确认版本，刷新后数据一致；
  - `TrimPanel.tsx` 侧栏页面，只负责展示与交互。
