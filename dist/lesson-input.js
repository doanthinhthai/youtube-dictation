import { parseSubtitles } from './core.js';

const forms = new Set(['paste', 'txt', 'srt', 'vtt']);

function parseTimed(text, format) {
  const blocks = text.split(/\n[ \t]*\n+/);
  if (format === 'vtt' && !/^WEBVTT(?:[ \t]|$)/.test(blocks[0].split('\n')[0])) {
    throw new Error('File VTT cần có dòng WEBVTT ở đầu.');
  }
  const segments = [];
  let lastStart = -1;
  for (const block of blocks) {
    if (format === 'vtt' && /^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(block.trim())) continue;
    if (!block.trim()) continue;
    try {
      for (const { text, start, end } of parseSubtitles(block)) {
        if (start < lastStart) throw new Error();
        segments.push({ text, start, end });
        lastStart = start;
      }
      if (block.split('\n').filter(line => line.includes('-->')).length !== 1) throw new Error();
    } catch {
      throw new Error('Phụ đề có mốc thời gian hoặc lời thoại không hợp lệ gần câu ' + (segments.length + 1) + '.');
    }
  }
  if (!segments.length) throw new Error('Phụ đề chưa có câu kèm mốc thời gian.');
  return segments;
}

export function parseLessonInput({ format = 'paste', text = '' }) {
  const cleaned = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!forms.has(format) || !cleaned) throw new Error('Hãy thêm lời thoại hoặc chọn một tệp lời thoại.');
  if (cleaned.length > 125000) throw new Error('Lời thoại quá dài. Hãy tách thành nhiều bài.');
  const timed = format === 'srt' || format === 'vtt';
  const segments = timed ? parseTimed(cleaned, format) : cleaned.split(/\n+|(?<=[.!?])\s+/u)
    .map(line => line.trim()).filter(Boolean).map(line => ({ text: line, start: null, end: null }));
  if (segments.length > 2500 || segments.some(cue => cue.text.length > 16000)) {
    throw new Error('Lời thoại cần chia thành các bài hoặc câu ngắn hơn.');
  }
  return { transcript: timed ? segments.map(cue => cue.text).join('\n') : cleaned, segments };
}

export function isWholeLesson(lesson) {
  return Array.isArray(lesson?.segments) && lesson.segments.some(cue =>
    !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start);
}

export function parseYouTubeId(address) {
  let parsed;
  try { parsed = new URL(address.trim()); } catch { /* validation below */ }
  let id;
  if (parsed?.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port) {
    if (parsed.hostname === 'youtu.be') id = parsed.pathname.split('/')[1];
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(parsed.hostname)) {
      if (parsed.pathname === '/watch') id = parsed.searchParams.get('v');
      else id = parsed.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)\/?$/)?.[1];
    }
  }
  if (!/^[\w-]{11}$/.test(id ?? '')) throw new Error('Hãy dán link video YouTube hợp lệ.');
  return id;
}

export function audioMime(file) {
  const name = file?.name?.toLowerCase() ?? '';
  if (name.endsWith('.mp3')) return 'audio/mpeg';
  if (name.endsWith('.m4a') || name.endsWith('.mp4') && file.type === 'audio/mp4') return 'audio/mp4';
  throw new Error('Hãy chọn file audio MP3 hoặc M4A.');
}
