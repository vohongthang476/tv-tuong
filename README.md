# TV TƯỢNG – Quản lý Xưởng & Điểm bán (v4)

Website: https://vohongthang476.github.io/tv-tuong/

## Kiến trúc
- **index.html** – ứng dụng 1 file (GitHub Pages). Dữ liệu chính: **Supabase** (đăng nhập Supabase Auth, RLS).
- **Trợ lý AI** – gọi Cloudflare Worker `tv-tuong-ai` (Gemini, tự chọn model khả dụng, fallback khi lỗi/quota). API key chỉ nằm trong Cloudflare Secret `GEMINI_API_KEY`.
- **Ghi dữ liệu** – chỉ qua các hàm nghiệp vụ cố định trên Supabase: `tv_stock_in, tv_create_store, tv_create_product, tv_create_combo, tv_build_combo, tv_consign, tv_reconcile, tv_record_payment, tv_assign_rack, tv_return_rack` (mỗi hàm là 1 giao dịch, có kiểm tra tồn/công nợ).
- AI chỉ đề xuất *action có cấu trúc* → website hiện **bản xem trước** → người dùng bấm **Xác nhận** → mới gọi hàm nghiệp vụ. Mọi lệnh AI được ghi vào bảng `ai_commands`.

## Bảo mật
- Frontend chỉ chứa Supabase *Publishable key* (khóa công khai). Không có secret/service_role trong repo.
- AI không được chạy SQL tùy ý.
