/* "My reading materials" shelf in the Reader: transcripts and articles you paste and keep,
   such as BBC Learning English episodes. Saved in state.materials, so they sync and back up
   with the rest of the learning data but are never published. */
'use strict';

const MATERIAL_TYPE_NAMES = { book: 'Book', news: 'News', conversation: 'Conversation', other: 'Other' };

// Saves state; on failure (e.g. storage full) puts the previous list back and returns false
function commitMaterials(next, failMessage) {
  const previous = state.materials;
  state.materials = next;
  try {
    saveState();
    return true;
  } catch (error) {
    state.materials = previous;
    console.warn('Reading materials not saved', error);
    toast(failMessage, 4000);
    return false;
  }
}

function renderReadingMaterials() {
  const container = document.getElementById('readerMaterialsList');
  const materials = MaterialStore.visible(state.materials);
  if (!materials.length) {
    container.innerHTML = '<p class="hint">No saved materials yet. Paste a transcript or article below and save it here. / 还没有保存的材料。</p>';
    return;
  }
  container.innerHTML = materials.map(item => {
    const words = item.text.split(/\s+/).filter(Boolean).length;
    const source = /^https?:\/\//.test(item.sourceUrl) ? `<a href="${escapeHTML(item.sourceUrl)}" target="_blank" rel="noopener">Source ↗</a>` : '';
    return `<article class="reader-shelf-card reader-material-card" data-material-id="${escapeHTML(item.id)}">
      <b>${escapeHTML(item.title)}</b>
      <span class="reader-material-meta">${MATERIAL_TYPE_NAMES[item.type]} · ${words.toLocaleString()} words</span>
      ${source}
      <div class="reader-material-actions">
        <button class="btn-primary" data-material-act="open">Open in Reader</button>
        <button class="btn-ghost" data-material-act="delete" aria-label="Delete ${escapeHTML(item.title)}">Delete</button>
      </div>
    </article>`;
  }).join('');
}

// Reads and checks the paste form; returns null after telling the user what to fix
function readMaterialForm() {
  const titleInput = document.getElementById('readerTitle');
  const title = titleInput.value.trim();
  const text = document.getElementById('readerInput').value.trim();
  if (!title) { toast('Add a title before saving this material'); titleInput.focus(); return null; }
  if (!text) { toast('Paste the article or transcript first'); return null; }
  if (text.length > MaterialStore.MAX_MATERIAL_CHARS) {
    toast(`Too long — save up to ${MaterialStore.MAX_MATERIAL_CHARS.toLocaleString()} characters at a time`, 3500);
    return null;
  }
  const sourceValue = document.getElementById('readerMaterialSource').value.trim();
  let sourceUrl = '';
  if (sourceValue) {
    try {
      const url = new URL(sourceValue);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported URL');
      sourceUrl = url.href;
    } catch {
      toast('Enter a valid http or https source link');
      return null;
    }
  }
  return { title, type: document.getElementById('readerMaterialType').value, sourceUrl, text };
}

function saveCurrentReadingMaterial() {
  const form = readMaterialForm();
  if (!form) return;
  if (MaterialStore.isFull(state.materials, form.title)) {
    toast(`Your shelf is full (${MaterialStore.MAX_MATERIALS}). Delete a material you've finished first.`, 4000);
    return;
  }
  const titleKey = form.title.toLocaleLowerCase();
  const isUpdate = MaterialStore.visible(state.materials).some(item => item.title.toLocaleLowerCase() === titleKey);
  const entry = MaterialStore.createEntry(form, new Date().toISOString(), uid());
  if (!commitMaterials(MaterialStore.upsert(state.materials, entry), 'Could not save this material — browser storage may be full.')) return;
  renderReadingMaterials();
  document.getElementById('readerMaterialsShelf').open = true;
  toast(isUpdate ? 'Reading material updated' : 'Reading material saved');
}

function openReadingMaterial(item) {
  clearReader();
  document.getElementById('readerTitle').value = item.title;
  document.getElementById('readerMaterialType').value = item.type;
  document.getElementById('readerMaterialSource').value = item.sourceUrl;
  document.getElementById('readerInput').value = item.text;
  analyzeReaderText();
  document.getElementById('readerPaste').open = false;
}

function deleteReadingMaterial(item) {
  if (!confirm(`Delete "${item.title}" from your materials?`)) return;
  if (commitMaterials(MaterialStore.remove(state.materials, item.id, new Date().toISOString()), 'Could not delete it — please try again.')) {
    renderReadingMaterials();
  }
}

function onMaterialsClick(event) {
  const button = event.target.closest('[data-material-act]');
  if (!button) return;
  const id = button.closest('[data-material-id]')?.dataset.materialId;
  const item = MaterialStore.visible(state.materials).find(material => material.id === id);
  if (!item) return;
  if (button.dataset.materialAct === 'open') openReadingMaterial(item);
  else if (button.dataset.materialAct === 'delete') deleteReadingMaterial(item);
}

function initReadingMaterials() {
  renderReadingMaterials();
  document.getElementById('readerSaveMaterialBtn').addEventListener('click', saveCurrentReadingMaterial);
  document.getElementById('readerMaterialsList').addEventListener('click', onMaterialsClick);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initReadingMaterials);
else initReadingMaterials();
