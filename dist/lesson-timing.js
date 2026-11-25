import { escapeHTML as e } from './core.js';

export function validateTiming(marks, duration = Infinity) {
  let previous = -1;
  return marks.map(({ start, end }, index) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 ||
        start < previous || end <= start || end > duration + 0.05) {
      throw new Error('Kiểm tra mốc bắt đầu và kết thúc ở câu ' + (index + 1) + '.');
    }
    previous = start;
    return { start, end };
  });
}

export function showTimingEditor(dialog, { lesson, mountYouTube, save, onSaved }) {
  const isYouTube = lesson.kind === 'youtube';
  const source = isYouTube ? '<div class="youtube-player"><div data-youtube></div></div>'
    : '<audio controls preload="metadata" src="' + e(lesson.media) + '"></audio>';
  const mark = (label, value, side) => '<label class="field">' + label + '<input type="number" step=".01" min="0" data-mark="' +
    side + '" value="' + (Number.isFinite(value) ? e(value) : '') + '"></label><button type="button" class="text-btn" data-capture="' +
    side + '">Lấy vị trí ' + label.toLowerCase() + '</button>';
  const rows = lesson.segments.map((cue, i) => '<div class="timing-row" data-timing><p><b>Câu ' + (i + 1) + '</b> ' +
    e(cue.text) + '</p><div class="row wrap">' + mark('Đầu', cue.start, 'start') + mark('Cuối', cue.end, 'end') + '</div></div>');
  dialog.innerHTML = '<div class="modal-head"><h2>Đánh dấu mốc từng câu</h2><button class="icon-btn" type="button" ' +
    'data-action="close-modal" aria-label="Đóng">×</button></div><form class="modal-body timing-editor" novalidate>' + source +
    '<p class="small muted">Phát audio hoặc video, rồi lấy vị trí đang nghe cho đầu và cuối mỗi câu.</p>' +
    '<div class="timing-list">' + rows.join('') + '</div><p role="status" aria-live="polite"></p>' +
    '<button class="btn primary" type="submit">Lưu mốc</button></form>';
  const form = dialog.querySelector('form');
  const status = form.querySelector('[role=status]');
  const submit = form.querySelector('[type=submit]');
  const media = isYouTube ? mountYouTube(form.querySelector('[data-youtube]'), lesson.youtubeId) : form.querySelector('audio');
  if (isYouTube) dialog.addEventListener('close', () => media.destroy(), { once: true });
  form.addEventListener('click', event => {
    const control = event.target.closest('[data-capture]');
    if (control && Number.isFinite(media.currentTime)) {
      control.closest('[data-timing]').querySelector('[data-mark="' + control.dataset.capture + '"]').value =
        media.currentTime.toFixed(2);
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      if (!Number.isFinite(media.duration)) throw new Error('Mở audio hoặc video để kiểm tra thời lượng trước khi lưu.');
      const timing = validateTiming(Array.from(form.querySelectorAll('[data-timing]'), row => ({
        start: row.querySelector('[data-mark=start]').valueAsNumber,
        end: row.querySelector('[data-mark=end]').valueAsNumber,
      })), media.duration);
      await save(timing);
      dialog.close();
      await onSaved();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  if (!dialog.open) dialog.showModal();
}
