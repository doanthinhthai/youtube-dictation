# Dicta Online

Web luyện nghe TOEIC đã đóng gói trong `dist/`. Giao diện và bài mẫu là
file tĩnh. Người học có thể luyện bài mẫu ngay. Supabase Auth dùng cho
đăng nhập, tiến độ theo tài khoản và bài riêng.

## Kích hoạt đăng nhập trên bản Cloudflare Workers

1. Trong Supabase SQL Editor, chạy `supabase/online.sql` rồi
   `supabase/auth.sql`. Hai file có thể chạy lại. Giữ **Confirm email**
   bật trong cài đặt Email. Để mở đăng ký mới, bật **Allow new users
   to sign up**. Nếu dùng email xác nhận cho nhiều người, cấu hình SMTP
   riêng theo hướng dẫn Supabase. Với vài người thử, có thể tạo tài khoản
   đã xác minh trong **Authentication → Users**.
2. Trong **Authentication → URL Configuration**, đặt Site URL là
   `https://youtube-dictation.thinhdt-qt.workers.dev`. Thêm ba Redirect URLs:
   - `https://youtube-dictation.thinhdt-qt.workers.dev/?auth=signin`
   - `https://youtube-dictation.thinhdt-qt.workers.dev/?auth=confirm`
   - `https://youtube-dictation.thinhdt-qt.workers.dev/?auth=reset`
3. Trong Cloudflare **Workers & Pages → youtube-dictation → Settings →
   Variables and Secrets**, thêm hai giá trị dưới dạng **Secret**:
   - `SUPABASE_PUBLISHABLE_KEY` lấy từ Supabase API Keys, bắt đầu bằng
     `sb_publishable_`. Website tự lấy khóa công khai này.
   - `SUPABASE_SECRET_KEY` lấy từ cùng project, bắt đầu bằng
     `sb_secret_`. Worker giữ khóa này để tra cứu tên người dùng.
     Giữ nó ngoài Git, `dist/` và chat.
4. Trong phần **Builds** của Worker, để Build command trống và dùng
   Deploy command `npx wrangler deploy`. Repo có cấu hình
   `wrangler.jsonc` cho Worker `youtube-dictation` và thư mục
   `dist/`. Push lên `main` để deploy bản mới.
5. Vào [Google Cloud Console](https://console.cloud.google.com/), cấu
   hình consent screen và tạo OAuth client loại **Web application**.
   Authorized redirect URI là
   `https://fejklynoerubxjohijyy.supabase.co/auth/v1/callback`.
   Thêm Client ID và Client Secret ở **Authentication → Sign In /
   Providers → Google** trong Supabase. Nếu Google đang ở chế độ
   **Testing**, thêm email thử vào danh sách **Test users**.

Đăng ký bằng tên người dùng, email và mật khẩu. Khi đã xác nhận email,
đăng nhập bằng email một lần nếu mở thư trên trình duyệt khác. Dicta lưu
tên cho tài khoản sau khi đăng nhập. Tài khoản cũ có thể đặt tên trong
**Tài khoản → Lưu tên người dùng**. Tên gồm 3–24 chữ cái, chữ số hoặc
dấu gạch dưới.

Google và email dùng phiên Supabase hiện có. Dữ liệu đồng bộ vẫn gắn
với ID tài khoản Supabase. Việc chuyển bài cũ từ PC là bước riêng.

- [Cấu hình Google cho Supabase](https://supabase.com/docs/guides/auth/social-sign-in/auth-google)
- [Giới hạn email Supabase Auth](https://supabase.com/docs/guides/auth/rate-limits)
- [Lưu secret trên Cloudflare](https://developers.cloudflare.com/workers/configuration/secrets/)
