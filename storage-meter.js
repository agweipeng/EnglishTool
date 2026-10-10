/* Settings → Storage: how much of the browser's space the learning data uses.
   All learning data is one localStorage entry (and the same JSON is the cloud-sync file),
   and browsers allow about 5 MB per site, so this warns well before saving can fail. */
'use strict';

const STORAGE_LIMIT_CHARS = 5_000_000;   // about 5 MB of localStorage per site
const STORAGE_WARN_RATIO = 0.6;          // about 3 MB: time to tidy up
const STORAGE_HIGH_RATIO = 0.9;          // new saves may soon fail

const jsonLength = value => (value === undefined ? 0 : JSON.stringify(value).length);
const liveCount = list => (Array.isArray(list) ? list.filter(entry => entry && !entry.deleted).length : 0);

// Sizes in characters of the saved JSON, roughly bytes for English text
function measureStorage(data) {
  const total = jsonLength(data);
  const analyses = { size: jsonLength(data.analyses), count: liveCount(data.analyses) };
  const materials = { size: jsonLength(data.materials), count: liveCount(data.materials) };
  const quizzes = { size: jsonLength(data.quizzes), count: liveCount(data.quizzes) };
  const learning = { size: total - analyses.size - materials.size - quizzes.size, count: liveCount(data.words) };
  const ratio = total / STORAGE_LIMIT_CHARS;
  const level = ratio >= STORAGE_HIGH_RATIO ? 'high' : ratio >= STORAGE_WARN_RATIO ? 'warn' : 'ok';
  return { total, ratio, level, learning, analyses, materials, quizzes };
}

function formatSize(chars) {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} MB`;
  return `${chars === 0 ? 0 : Math.max(1, Math.round(chars / 1000))} KB`;
}

const countOf = (count, one, many) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

const STORAGE_ADVICE = {
  warn: 'Getting full: delete reading materials you have finished, or use Export JSON to keep a backup. / 空间快满了：请删除已读完的阅读材料，或导出 JSON 备份。',
  high: 'Almost full: new saves may fail. Delete reading materials or saved analyses you no longer need. / 空间几乎已满，新内容可能无法保存：请删除不再需要的阅读材料或解析。',
};

function renderStorageMeter() {
  const meter = document.getElementById('storageMeter');
  if (!meter) return;
  const usage = measureStorage(state);
  const percent = Math.round(usage.ratio * 100);
  const parts = [
    `Words &amp; progress ${formatSize(usage.learning.size)} (${countOf(usage.learning.count, 'word', 'words')})`,
    `Saved analyses ${formatSize(usage.analyses.size)} (${countOf(usage.analyses.count, 'analysis', 'analyses')})`,
    `Reading materials ${formatSize(usage.materials.size)} (${countOf(usage.materials.count, 'reading material', 'reading materials')})`,
    `Quizzes ${formatSize(usage.quizzes.size)} (${countOf(usage.quizzes.count, 'quiz', 'quizzes')})`,
  ];
  meter.innerHTML = `<div class="storage-bar storage-${usage.level}" role="meter" aria-label="Storage used / 已用空间"
      aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${Math.min(percent, 100)}%"></span></div>
    <p>${formatSize(usage.total)} of about 5 MB used (${percent}%) · 已使用 ${formatSize(usage.total)}，上限约 5 MB</p>
    <p class="hint">${parts.join(' · ')}</p>
    ${STORAGE_ADVICE[usage.level] ? `<p class="storage-advice">${STORAGE_ADVICE[usage.level]}</p>` : ''}`;
}
