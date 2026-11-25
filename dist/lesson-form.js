import { audioMime, parseLessonInput, parseYouTubeId } from './lesson-input.js';

const formHTML = [
  '<div class="modal-head"><h2>Thêm bài riêng</h2>',
  '<button class="icon-btn" type="button" data-action="close-modal" aria-label="Đóng">×</button></div>',
  '<form class="modal-body private-lesson-form" novalidate>',
  '<label class="field">Tên bài<input name="title" maxlength="160" required></label>',
  '<fieldset><legend>Chọn nguồn nghe</legend><div class="row wrap">',
  '<label><input type="radio" name="source" value="audio" checked> Tải audio</label>',
  '<label><input type="radio" name="source" value="youtube"> Dán link YouTube</label></div>',
  '<label class="field" data-source="audio">File MP3 hoặc M4A<input type="file" name="audio" accept=".mp3,.m4a,audio/mpeg,audio/mp4"></label>',
  '<label class="field" data-source="youtube" hidden>Link YouTube<input name="youtube" type="url" placeholder="https://youtu.be/…"></label></fieldset>',
  '<fieldset><legend>Thêm lời thoại</legend><div class="row wrap">',
  '<label><input type="radio" name="input" value="paste" checked> Dán lời thoại</label>',
  '<label><input type="radio" name="input" value="file"> Tải tệp lời thoại</label></div>',
  '<label class="field" data-input="paste">Lời thoại<textarea name="transcript" rows="6" maxlength="125000"></textarea></label>',
  '<label class="field" data-input="file" hidden>Tệp TXT, SRT hoặc VTT<input type="file" name="subtitle" accept=".txt,.srt,.vtt,text/plain,text/vtt"></label>',
  '<p class="small muted">Dán lời thoại hoặc chọn TXT để luyện cả bài. SRT và VTT có mốc sẵn để luyện từng câu.</p></fieldset>',
  '<p role="status" aria-live="polite"></p><button class="btn primary" type="submit">Lưu &amp; luyện</button></form>',
].join('');

export function showLessonForm(dialog, { save, onSaved }) {
  dialog.innerHTML = formHTML;
  const form = dialog.querySelector('form');
  const status = form.querySelector('[role=status]');
  const submit = form.querySelector('[type=submit]');
  let id = crypto.randomUUID();
  let busy = false;

  function reflectFields() {
    for (const field of form.querySelectorAll('[data-source]')) field.hidden = field.dataset.source !== form.elements.source.value;
    for (const field of form.querySelectorAll('[data-input]')) field.hidden = field.dataset.input !== form.elements.input.value;
  }
  form.addEventListener('input', () => { id = crypto.randomUUID(); });
  form.addEventListener('change', reflectFields);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    submit.disabled = true;
    try {
      const title = form.elements.title.value.trim();
      if (!title) throw new Error('Nhập tên bài luyện.');
      const usesFile = form.elements.input.value === 'file';
      const file = form.elements.subtitle.files[0];
      if (usesFile && !file) throw new Error('Chọn tệp lời thoại trước khi lưu.');
      if (usesFile && file.size > 500000) throw new Error('Tệp lời thoại quá lớn. Hãy chia nhỏ trước khi tải.');
      const content = parseLessonInput(usesFile
        ? { format: file.name.split('.').at(-1).toLowerCase(), text: await file.text() }
        : { text: form.elements.transcript.value });
      const isAudio = form.elements.source.value === 'audio';
      const audio = isAudio ? form.elements.audio.files[0] : null;
      const payload = { id, title, ...content };
      if (isAudio) {
        if (!audio) throw new Error('Chọn file MP3 hoặc M4A trước khi lưu.');
        payload.audio = { bytes: audio.size, mime: audioMime(audio) };
      } else payload.youtubeId = parseYouTubeId(form.elements.youtube.value);
      status.textContent = 'Đang lưu bài riêng…';
      await save(payload, audio);
      await onSaved(id);
      if (dialog.open) dialog.close();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      submit.disabled = false;
    }
  });
  if (!dialog.open) dialog.showModal();
}
