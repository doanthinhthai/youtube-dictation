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

## Bài riêng và đồng bộ tiến độ

Bài riêng chỉ hiển thị cho tài khoản sở hữu. Người học có thể tải MP3
hoặc M4A, hoặc dùng video YouTube cho phép nhúng. Nhập lời thoại bằng
cách dán văn bản, mở TXT, hoặc tải SRT/VTT. Lời thoại chưa có mốc dùng
chế độ luyện cả bài và có thể ghi mốc từng câu sau.

- Áp dụng lần lượt các file SQL `online.sql`, `auth.sql`,
  `20261125_progress.sql` và `20261125_private_lessons.sql` trong môi
  trường Supabase thử nghiệm. Với môi trường đang chạy, xác minh schema
  gốc trước. Nếu đã có migration mới, tránh chạy lại riêng schema gốc
  vì schema đó cài lại các chính sách và hàm của phiên bản cũ.
- Cài `SUPABASE_PUBLISHABLE_KEY` và `SUPABASE_SECRET_KEY` ở Cloudflare.
  Sửa `DICTA_ACCOUNT_AUDIO_LIMIT_BYTES` trong Wrangler nếu cần đổi mức
  30.000.000 byte mỗi tài khoản. Trần dự án trong SQL giữ ở
  900.000.000 byte. Quota tính theo dung lượng audio đã lưu và các lượt
  đang tải. Tạo bài YouTube không giữ chỗ audio.
- Trước khi mở đăng ký công khai, thử callback Google với tài khoản
  người dùng mới và kiểm tra thư xác nhận ngoài nhóm quản trị. Nếu
  thiết lập gửi thư của dự án chưa đáp ứng, hoàn tất SMTP trước khi
  bật luồng email.
- Chạy `node --test`, thử gói `wrangler deploy --dry-run`, rồi chạy
  các ca `tests/sql/progress.sql` và `tests/sql/private-lessons.sql`
  trên PostgreSQL thử đã áp dụng schema. Các ca SQL dùng giao dịch
  rollback và tài khoản thử riêng.
- Kiểm tra phê duyệt bản phát hành với hai tài khoản và hai thiết bị,
  gồm cách ly audio, ngắt kết nối lúc chấm bài, upload sát quota và
  video bị chặn nhúng. Khi phải lùi phiên bản, dùng bản hỗ trợ RPC
  gộp tiến độ. RPC snapshot cũ sẽ yêu cầu tải lại trang nếu tài khoản
  đã ghi bằng luồng mới.

`dist/` là nguồn phát hành của repo này. Khi lấy lại giao diện dùng
chung từ Dicta Local, giữ các thay đổi cho chế độ online trong
`dist/app.js`, `dist/online.js`, `dist/_headers`, `dist/online.css`
và các mô-đun bài riêng, trình phát, đồng bộ. Đóng gói vào thư mục thử
trước rồi đối chiếu với `dist/` phiên bản hiện tại.

- [Cấu hình Google cho Supabase](https://supabase.com/docs/guides/auth/social-sign-in/auth-google)
- [Giới hạn email Supabase Auth](https://supabase.com/docs/guides/auth/rate-limits)
- [Lưu secret trên Cloudflare](https://developers.cloudflare.com/workers/configuration/secrets/)
