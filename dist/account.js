import { escapeHTML as e } from './core.js';

const usernamePattern = /^[a-z0-9_]{3,24}$/;
const unavailable = 'Đăng nhập chưa được cấu hình. Bạn có thể luyện bài mẫu trong lúc này.';
const emailField = '<div class="field"><label for="dicta-email">Email</label><input id="dicta-email" type="email" name="email" autocomplete="email" required maxlength="254"></div>';
const usernameField = name => `<div class="field"><label for="dicta-username">Tên người dùng</label><input id="dicta-username" name="username" autocomplete="username" required minlength="3" maxlength="24" pattern="[a-zA-Z0-9_]{3,24}" value="${e(name)}"><small>3–24 ký tự gồm chữ cái, số hoặc dấu gạch dưới.</small></div>`;
const passwordField = create => `<div class="field"><label for="dicta-password">${create ? 'Mật khẩu mới' : 'Mật khẩu'}</label><input id="dicta-password" name="password" type="password" autocomplete="${create ? 'new-password' : 'current-password'}" ${create ? 'minlength="8"' : ''} required maxlength="256"></div>`;

function modal(title, content) {
  const dialog = document.querySelector('#modal');
  dialog.innerHTML = `<div class="modal-head"><h2>${e(title)}</h2><button class="icon-btn" data-action="close-modal" aria-label="Đóng">×</button></div><div class="modal-body">${content}<p class="small muted dicta-auth-status" role="status"></p></div>`;
  if (!dialog.open) dialog.showModal();
  return dialog;
}

async function readRuntimeConfig(projectUrl, buildKey) {
  try {
    const response = await fetch('/api/auth/config', { signal: AbortSignal.timeout(4000), cache: 'no-store' });
    if (response.ok) {
      const result = await response.json();
      if (result.url === projectUrl && /^sb_publishable_[\w-]+$/.test(result.key)) return result;
    }
  } catch {}
  return /^sb_publishable_[\w-]+$/.test(buildKey) ? { url: projectUrl, key: buildKey, hasUsername: false } : null;
}

function authError(error, defaultMessage) {
  if (error?.status === 429 || error?.code === 'over_email_send_rate_limit') {
    return 'Bạn đã thử quá nhiều lần. Vui lòng thử lại sau.';
  }
  if (error?.code === 'email_not_confirmed') return 'Hãy xác nhận email rồi đăng nhập lại.';
  if (error?.code === 'weak_password') return 'Hãy chọn mật khẩu dài và khó đoán hơn.';
  if (error?.code === 'signup_disabled') return 'Đăng ký tài khoản mới hiện đang tạm đóng.';
  return defaultMessage;
}

export async function connectAccount(projectUrl, buildKey) {
  const auth = { client: null, key: null, session: null, username: '', onSession: null, show: null };
  const url = new URL(location.href);
  const callbackMode = url.searchParams.get('auth');
  let callbackMessage = url.searchParams.has('error') || new URLSearchParams(url.hash.slice(1)).has('error')
    ? 'Chưa hoàn tất đăng nhập hoặc xác nhận email. Hãy thử lại.' : '';
  const config = await readRuntimeConfig(projectUrl, buildKey);
  const redirect = mode => location.origin + '/?auth=' + mode;

  const claim = async username => {
    const normalized = username.trim().toLowerCase();
    if (!usernamePattern.test(normalized)) throw new Error('Tên người dùng cần có 3–24 chữ cái, chữ số hoặc dấu gạch dưới.');
    const { data, error } = await auth.client.rpc('dicta_claim_username', { p_username: normalized });
    if (error?.code === '23505') throw new Error('Tên này đã được sử dụng. Hãy chọn tên khác.');
    if (error) throw new Error('Chưa lưu được tên người dùng. Hãy kiểm tra xác nhận email hoặc thử lại sau.');
    auth.username = data;
  };

  if (config) {
    try {
      const { default: sdk } = await import('./vendor/supabase.js');
      auth.client = sdk.createClient(config.url, config.key, { auth: { flowType: 'pkce', detectSessionInUrl: true } });
      auth.key = config.key;
      const result = await auth.client.auth.getSession();
      auth.session = result.data.session;
      if (result.error) callbackMessage = 'Phiên đăng nhập đã hết hạn hoặc liên kết xác nhận đã được dùng.';
      auth.client.auth.onAuthStateChange((event, next) => {
        const previousId = auth.session?.user.id;
        auth.session = next;
        auth.onSession?.(next);
        if (event === 'SIGNED_OUT' && previousId) location.reload();
        if (event === 'SIGNED_IN' && previousId !== next?.user.id) location.reload();
      });
    } catch {
      auth.client = null;
      auth.session = null;
    }
  }

  if (auth.session) {
    try {
      const { data } = await auth.client.from('dicta_online_usernames').select('username')
        .eq('user_id', auth.session.user.id).maybeSingle();
      auth.username = data?.username ?? '';
      const requested = auth.session.user.user_metadata?.dicta_requested_username;
      if (!auth.username && typeof requested === 'string' && usernamePattern.test(requested)) await claim(requested);
    } catch (error) {
      callbackMessage = error.message;
    }
  }

  function run(dialog, action) {
    return async event => {
      event.preventDefault();
      const control = event.submitter || event.currentTarget;
      const status = dialog.querySelector('[role=status]');
      control.disabled = true;
      status.textContent = 'Đang xử lý…';
      try {
        status.textContent = await action(new FormData(dialog.querySelector('form') || document.createElement('form'))) || '';
      } catch (error) {
        status.textContent = error.message || 'Thao tác chưa thành công. Hãy thử lại.';
      } finally {
        control.disabled = false;
      }
    };
  }

  auth.show = function show(mode = auth.session ? 'profile' : 'login') {
    if (!auth.client) {
      modal('Đăng nhập Dicta', `<p class="muted">${unavailable}</p>`);
      return;
    }
    if (mode === 'profile') {
      const dialog = modal('Tài khoản Dicta', `<p>${e(auth.session?.user.email ?? '')}</p><form>${usernameField(auth.username)}<button class="btn primary">Lưu tên người dùng</button></form><div class="dicta-auth-actions"><button type="button" class="text-btn" id="dicta-signout">Đăng xuất</button></div>`);
      dialog.querySelector('form').onsubmit = run(dialog, async form => {
        await claim(String(form.get('username')));
        return 'Đã lưu tên người dùng.';
      });
      dialog.querySelector('#dicta-signout').onclick = run(dialog, async () => {
        const { error } = await auth.client.auth.signOut({ scope: 'local' });
        if (error) throw new Error('Chưa đăng xuất được. Hãy thử lại.');
        location.replace(location.origin + '/');
      });
      return;
    }
    if (mode === 'signup') {
      const dialog = modal('Tạo tài khoản Dicta', `<form>${usernameField('')}${emailField}${passwordField(true)}<button class="btn primary">Tạo tài khoản</button></form><button type="button" class="text-btn dicta-auth-back">Về đăng nhập</button>`);
      dialog.querySelector('.dicta-auth-back').onclick = () => show('login');
      dialog.querySelector('form').onsubmit = run(dialog, async form => {
        const username = String(form.get('username')).trim().toLowerCase();
        const email = String(form.get('email')).trim();
        const { data, error } = await auth.client.auth.signUp({
          email, password: String(form.get('password')),
          options: { emailRedirectTo: redirect('confirm'), data: { dicta_requested_username: username } },
        });
        if (error) throw new Error(authError(error, 'Chưa tạo được tài khoản. Kiểm tra thông tin rồi thử lại.'));
        if (data.session) {
          location.replace(location.origin + '/');
          return;
        }
        return 'Hãy mở thư xác nhận. Khi xác nhận xong, bạn có thể dùng email để đăng nhập lần đầu.';
      });
      return;
    }
    if (mode === 'forgot' || mode === 'reset') {
      const reset = mode === 'reset' && !!auth.session;
      const dialog = modal(reset ? 'Chọn mật khẩu mới' : 'Khôi phục mật khẩu',
        `<form>${reset ? passwordField(true) : emailField}<button class="btn primary">${reset ? 'Lưu mật khẩu' : 'Gửi liên kết'}</button></form><button type="button" class="text-btn dicta-auth-back">Quay lại</button>`);
      dialog.querySelector('.dicta-auth-back').onclick = () => show();
      dialog.querySelector('form').onsubmit = run(dialog, async form => {
        if (reset) {
          const { error } = await auth.client.auth.updateUser({ password: String(form.get('password')) });
          if (error) throw new Error(authError(error, 'Chưa đổi được mật khẩu. Hãy yêu cầu liên kết mới nếu phiên đã hết hạn.'));
          show('profile');
          return;
        }
        const { error } = await auth.client.auth.resetPasswordForEmail(String(form.get('email')).trim(), {
          redirectTo: redirect('reset'),
        });
        if (error) throw new Error(authError(error, 'Chưa gửi được liên kết. Hãy thử lại sau.'));
        return 'Nếu email có tài khoản, bạn sẽ nhận được liên kết đặt lại mật khẩu.';
      });
      return;
    }
    const identifier = config.hasUsername ? 'Tên người dùng hoặc email' : 'Email';
    const dialog = modal('Đăng nhập Dicta',
      `<button class="btn secondary dicta-google" id="dicta-google" type="button">Tiếp tục với Google</button><div class="dicta-auth-divider">hoặc</div><form><div class="field"><label for="dicta-login">${identifier}</label><input id="dicta-login" name="login" autocomplete="username" required maxlength="254"></div>${passwordField(false)}<button class="btn primary">Đăng nhập</button></form><div class="dicta-auth-actions"><button class="text-btn" type="button" id="dicta-signup">Tạo tài khoản</button><button class="text-btn" type="button" id="dicta-forgot">Quên mật khẩu?</button></div>`);
    dialog.querySelector('#dicta-signup').onclick = () => show('signup');
    dialog.querySelector('#dicta-forgot').onclick = () => show('forgot');
    dialog.querySelector('#dicta-google').onclick = run(dialog, async () => {
      const { error } = await auth.client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirect('signin') } });
      if (error) throw new Error('Đăng nhập Google chưa sẵn sàng. Bạn có thể dùng tài khoản Dicta.');
    });
    dialog.querySelector('form').onsubmit = run(dialog, async form => {
      const login = String(form.get('login')).trim();
      const password = String(form.get('password'));
      if (login.includes('@')) {
        const { error } = await auth.client.auth.signInWithPassword({ email: login, password });
        if (error) throw new Error(authError(error, 'Tên đăng nhập hoặc mật khẩu chưa đúng.'));
      } else {
        const username = login.toLowerCase();
        if (!config.hasUsername || !usernamePattern.test(username)) throw new Error('Hãy nhập email hoặc tên người dùng hợp lệ.');
        const response = await fetch('/api/auth/username-login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Chưa đăng nhập được.');
        const { error } = await auth.client.auth.setSession(result);
        if (error) throw new Error('Chưa mở được phiên đăng nhập.');
      }
      location.replace(location.origin + '/');
    });
  };

  auth.finishCallback = () => {
    if (callbackMode || callbackMessage) {
      history.replaceState(null, '', location.pathname);
      if (callbackMode === 'reset' && auth.session) auth.show('reset');
      else if (callbackMessage) {
        auth.show();
        document.querySelector('#modal [role=status]').textContent = callbackMessage;
      } else if (callbackMode === 'confirm') auth.show();
    }
  };
  return auth;
}
