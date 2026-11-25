const bucket = 'dicta-online-audio';
const accountLimit = 30000000;
const fileLimit = 47185920;
const identifier = /^[a-zA-Z0-9_-]{1,100}$/;
const videoId = /^[\w-]{11}$/;
const userId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const media = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
};
const rpcErrors = {
  ACCOUNT_AUDIO_QUOTA: [409, 'Bạn đã dùng hết dung lượng audio của tài khoản.'],
  PROJECT_AUDIO_QUOTA: [409, 'Kho audio của Dicta đã đầy. Hãy thử lại sau.'],
  LESSON_NOT_FOUND: [404, 'Không tìm thấy bài này trong tài khoản.'],
  UPLOAD_BUSY: [409, 'Bài này đang được xử lý. Hãy thử lại sau.'],
  UPLOAD_SIZE_MISMATCH: [422, 'Kích thước audio không khớp. Hãy chọn lại file.'],
  INVALID_TIMING: [422, 'Mốc thời gian chưa hợp lệ.'],
  MEDIA_DELETE_PENDING: [503, 'Chưa xóa được audio. Hãy thử lại.'],
};

class LessonError extends Error {
  constructor(status, message, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function reply(value, status = 200) {
  return Response.json(value, {
    status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

function invalid(message) {
  return new LessonError(422, message);
}

function quota(env) {
  const supplied = Number(env.DICTA_ACCOUNT_AUDIO_LIMIT_BYTES);
  return Number.isSafeInteger(supplied) && supplied > 0 && supplied <= 900000000
    ? supplied : accountLimit;
}

async function readJSON(request) {
  if (!request.body || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw invalid('Thiếu dữ liệu bài luyện.');
  }
  const limit = 524288;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let output = '';
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new LessonError(413, 'Lời thoại quá dài. Hãy chia nội dung thành nhiều bài.');
      }
      output += decoder.decode(value, { stream: true });
    }
    try { return JSON.parse(output + decoder.decode()); }
    catch { throw invalid('Dữ liệu bài luyện không đúng định dạng.'); }
  } finally {
    reader.releaseLock();
  }
}

function isTiming(mark) {
  return Number.isFinite(mark?.start) && Number.isFinite(mark.end) && mark.start >= 0 && mark.end > mark.start;
}

function validateSegments(segments) {
  if (!Array.isArray(segments) || !segments.length || segments.length > 2500) {
    throw invalid('Lời thoại cần có từ 1 đến 2.500 câu.');
  }
  let previous = -1;
  return segments.map(segment => {
    const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
    if (!text || text.length > 16000) throw invalid('Mỗi câu cần có lời thoại hợp lệ.');
    const { start, end } = segment;
    if (start === null && end === null) return { text, start, end };
    if (!isTiming(segment) || start < previous) throw invalid('Kiểm tra lại thứ tự mốc thời gian.');
    previous = start;
    return { text, start, end };
  });
}

async function getActor(request, env) {
  const token = request.headers.get('Authorization');
  if (!/^Bearer [A-Za-z0-9._-]+$/.test(token ?? '') || token.length > 12000) {
    throw new LessonError(401, 'Hãy đăng nhập để quản lý bài cá nhân.');
  }
  const login = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: token },
    redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (!login.ok) {
    if (login.status >= 500) throw new LessonError(503, 'Tạm thời chưa xác minh được tài khoản.');
    throw new LessonError(401, 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.');
  }
  const { id } = await login.json();
  if (!userId.test(id || '')) throw new LessonError(401, 'Phiên đăng nhập không hợp lệ.');
  return id;
}

async function rpc(env, name, args) {
  const result = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/dicta_online_' + name, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (result.ok) return result.json();
  const data = await result.json().catch(() => ({}));
  const known = rpcErrors[data.message];
  if (Array.isArray(known)) throw new LessonError(known[0], known[1], data.message);
  throw new LessonError(503, 'Chưa lưu được bài trên Supabase. Hãy thử lại.');
}

async function create(request, env, owner) {
  const draft = await readJSON(request);
  const title = typeof draft?.title === 'string' ? draft.title.trim() : '';
  const transcript = typeof draft?.transcript === 'string' ? draft.transcript.trim() : '';
  if (!userId.test(draft?.id ?? '') || !title || title.length > 160 || !transcript || transcript.length > 125000) {
    throw invalid('Kiểm tra tên bài và lời thoại.');
  }
  const segments = validateSegments(draft.segments);
  const isYouTube = typeof draft.youtubeId === 'string' && videoId.test(draft.youtubeId);
  if (isYouTube === !!draft.audio) throw invalid('Chọn một file audio hoặc link YouTube hợp lệ.');
  const mime = draft.audio?.mime;
  const bytes = isYouTube ? 0 : draft.audio.bytes;
  if (!isYouTube && (!Object.hasOwn(media, mime) || !Number.isSafeInteger(bytes) || bytes < 1)) {
    throw invalid('Hãy chọn file MP3 hoặc M4A hợp lệ.');
  }
  const cap = quota(env);
  if (bytes > cap || bytes > fileLimit) {
    throw new LessonError(413, 'File audio vượt hạn mức cho phép.', 'FILE_AUDIO_LIMIT');
  }
  const lesson = {
    title, transcript, segments, kind: isYouTube ? 'youtube' : 'audio',
    topic: 'Cá nhân', part: '4', level: 'Intermediate',
    source: isYouTube ? 'YouTube' : 'Audio cá nhân',
    ...(isYouTube ? { youtubeId: draft.youtubeId } : {}),
  };
  const result = await rpc(env, 'create_lesson', {
    p_user: owner, p_id: draft.id, p_lesson: lesson, p_bytes: bytes,
    p_extension: isYouTube ? null : media[mime], p_quota: cap,
  });
  return reply(result, 201);
}

function exactStream(size) {
  if (typeof FixedLengthStream === 'function') return new FixedLengthStream(size);
  let length = 0;
  return new TransformStream({
    transform(chunk, controller) {
      length += chunk.byteLength;
      if (length > size) throw invalid('Kích thước audio vượt số byte đã giữ.');
      controller.enqueue(chunk);
    },
    flush() {
      if (length !== size) throw invalid('Kích thước audio thấp hơn số byte đã giữ.');
    },
  });
}

async function removeObject(env, path) {
  const result = await fetch(env.SUPABASE_URL + '/storage/v1/object/' + bucket, {
    method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [path] }),
  });
  if (!result.ok && result.status !== 404) throw new LessonError(503, 'Chưa xóa được audio. Hãy thử lại.');
}

async function upload(request, env, args) {
  const info = await rpc(env, 'begin_upload', args);
  if (!info.lease) return reply(info);
  const { audioPath, lease, bytes } = info;
  const leased = { ...args, p_lease: lease };
  const mime = request.headers.get('Content-Type');
  const declared = request.headers.get('Content-Length');
  if (!request.body || !Object.hasOwn(media, mime) || !audioPath.endsWith('.' + media[mime]) ||
      (declared !== null && Number(declared) !== bytes)) {
    await rpc(env, 'abort_upload', leased);
    throw invalid('File audio không khớp với thông tin đã đăng ký.');
  }
  const stream = exactStream(bytes);
  const cancel = new AbortController();
  const piping = request.body.pipeTo(stream.writable, { signal: cancel.signal });
  // A rejection may arrive before Storage replies. Observe it immediately.
  piping.catch(() => {});
  try {
    const result = await fetch(env.SUPABASE_URL + '/storage/v1/object/' + bucket + '/' + audioPath, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000), duplex: 'half',
      headers: { apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': mime, 'x-upsert': 'true' },
      body: stream.readable,
    });
    if (!result.ok) throw new LessonError(503, 'Audio chưa tải xong. Bạn có thể thử lại.');
    await piping;
  } catch (error) {
    cancel.abort();
    await piping.catch(() => {});
    try {
      await removeObject(env, audioPath);
      await rpc(env, 'abort_upload', leased);
    } catch { /* keep the reservation until the object can be recovered or cleaned */ }
    throw error;
  }
  return reply(await rpc(env, 'finish_upload', leased));
}

async function updateTiming(request, env, args) {
  const draft = await readJSON(request);
  const timing = draft?.timing;
  if (!Array.isArray(timing) || !timing.length || timing.length > 2500 || !timing.every(isTiming)) {
    throw invalid('Điền đủ mốc bắt đầu và kết thúc cho mỗi câu.');
  }
  return reply(await rpc(env, 'update_timing', {
    ...args, p_timing: timing.map(({ start, end }) => ({ start, end })),
  }));
}

export async function handleLessons(request, env, url) {
  try {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) throw new LessonError(403, 'Yêu cầu cần được gửi từ Dicta.');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(env.SUPABASE_URL ?? '') ||
        !/^sb_publishable_[\w-]+$/.test(env.SUPABASE_PUBLISHABLE_KEY ?? '') ||
        !/^sb_secret_[\w-]+$/.test(env.SUPABASE_SECRET_KEY ?? '')) {
      throw new LessonError(503, 'Lưu bài riêng chưa được cấu hình.');
    }
    const path = url.pathname.split('/').slice(3);
    const id = path[0];
    if (id && !identifier.test(id)) throw new LessonError(404, 'Không tìm thấy bài.');
    const owner = await getActor(request, env);
    const args = { p_user: owner, p_id: id };
    if (request.method === 'POST' && !path.length) return await create(request, env, owner);
    if (request.method === 'PUT' && path.length === 2 && path[1] === 'audio') {
      return await upload(request, env, args);
    }
    if (request.method === 'PATCH' && path.length === 1) return await updateTiming(request, env, args);
    if (request.method === 'DELETE' && path.length === 1) {
      const { audioPath } = await rpc(env, 'begin_delete', args);
      if (audioPath) await removeObject(env, audioPath);
      await rpc(env, 'finish_delete', args);
      return reply({ ok: true });
    }
    throw new LessonError(405, 'Thao tác bài luyện không hợp lệ.');
  } catch (error) {
    if (error instanceof LessonError) return reply({ error: error.message, code: error.code }, error.status);
    return reply({ error: 'Chưa xử lý được bài luyện. Hãy thử lại.' }, 503);
  }
}
