-- =====================================================================
-- TV TƯỢNG — Hàm nghiệp vụ an toàn (v1)
-- Mỗi hàm là 1 giao dịch (lỗi ở bước nào → hoàn tác toàn bộ).
-- SECURITY INVOKER: chạy bằng quyền người đăng nhập, vẫn tuân theo RLS.
-- Chỉ tạo/thay thế HÀM, không xóa/sửa bảng hay dữ liệu hiện có.
-- =====================================================================

create or replace function public.tv_num(v jsonb, def numeric default 0)
returns numeric language sql immutable set search_path = public as $$
  select case when v is null or jsonb_typeof(v) = 'null' or v #>> '{}' = '' then def
              else (v #>> '{}')::numeric end
$$;

create or replace function public.tv_product_lock(pid uuid)
returns public.products language plpgsql set search_path = public as $$
declare r public.products;
begin
  select * into r from public.products where id = pid for update;
  if not found then raise exception 'Không tìm thấy sản phẩm (id %)', pid; end if;
  return r;
end $$;

-- 1) NHẬP KHO ---------------------------------------------------------
-- p: {receipt_type, supplier, note, items:[{product_id, qty, unit_cost}]}
create or replace function public.tv_stock_in(p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_type text := coalesce(nullif(p->>'receipt_type',''), 'production');
  v_sup uuid; v_rid uuid; it jsonb; v_prod public.products; v_qty numeric; v_cost numeric;
  v_lines int := 0; v_total numeric := 0;
begin
  if v_type not in ('purchase','production','return','adjustment') then raise exception 'Loại phiếu nhập không hợp lệ: %', v_type; end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then raise exception 'Phiếu nhập chưa có dòng hàng nào'; end if;
  if nullif(trim(p->>'supplier'),'') is not null then
    select id into v_sup from public.suppliers where lower(name) = lower(trim(p->>'supplier')) limit 1;
    if v_sup is null then insert into public.suppliers(name) values (trim(p->>'supplier')) returning id into v_sup; end if;
  end if;
  insert into public.stock_receipts(receipt_type, supplier_id, note) values (v_type, v_sup, p->>'note') returning id into v_rid;
  for it in select * from jsonb_array_elements(p->'items') loop
    v_prod := public.tv_product_lock((it->>'product_id')::uuid);
    v_qty := public.tv_num(it->'qty');
    v_cost := public.tv_num(it->'unit_cost');
    if v_qty <= 0 then raise exception 'Số lượng nhập của "%" phải lớn hơn 0', v_prod.name; end if;
    if v_cost < 0 then raise exception 'Đơn giá của "%" không hợp lệ', v_prod.name; end if;
    insert into public.stock_receipt_items(receipt_id, product_id, quantity, unit_cost) values (v_rid, v_prod.id, v_qty, v_cost);
    update public.products set stock = stock + v_qty where id = v_prod.id;
    insert into public.stock_movements(product_id, movement_type, quantity, location_type, reference_type, reference_id, note)
      values (v_prod.id, 'receipt_' || v_type, v_qty, 'warehouse', 'stock_receipt', v_rid, p->>'note');
    v_lines := v_lines + 1; v_total := v_total + v_qty * v_cost;
  end loop;
  return jsonb_build_object('ok', true, 'receipt_id', v_rid, 'lines', v_lines, 'total', v_total);
end $$;

-- 2) THÊM ĐIỂM BÁN ---------------------------------------------------
create or replace function public.tv_create_store(p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v_name text := trim(coalesce(p->>'name','')); v_id uuid;
begin
  if v_name = '' then raise exception 'Chưa có tên cửa hàng'; end if;
  if exists (select 1 from public.stores where lower(name) = lower(v_name) and coalesce(lower(area),'') = coalesce(lower(nullif(trim(p->>'area'),'')),'')) then
    raise exception 'Cửa hàng "%" đã tồn tại', v_name; end if;
  insert into public.stores(name, area, phone, address, contact_name, code)
    values (v_name, nullif(trim(p->>'area'),''), nullif(trim(p->>'phone'),''), nullif(trim(p->>'address'),''), nullif(trim(p->>'contact_name'),''), nullif(trim(p->>'code'),''))
    returning id into v_id;
  return jsonb_build_object('ok', true, 'store_id', v_id, 'name', v_name);
end $$;

-- 3) THÊM SẢN PHẨM ---------------------------------------------------
create or replace function public.tv_create_product(p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v_name text := trim(coalesce(p->>'name','')); v_sku text := upper(trim(coalesce(p->>'sku',''))); v_cat uuid; v_id uuid;
  v_src text := coalesce(nullif(p->>'source_type',''),'purchased');
begin
  if v_name = '' then raise exception 'Chưa có tên sản phẩm'; end if;
  if v_src not in ('manufactured','purchased') then v_src := 'purchased'; end if;
  if v_sku = '' then v_sku := 'SP-' || to_char(now(),'YYMMDDHH24MISS'); end if;
  if exists (select 1 from public.products where upper(sku) = v_sku) then raise exception 'Mã sản phẩm "%" đã tồn tại', v_sku; end if;
  if exists (select 1 from public.products where lower(name) = lower(v_name)) then raise exception 'Sản phẩm "%" đã có trong danh mục', v_name; end if;
  select id into v_cat from public.product_categories where lower(name) = lower(coalesce(nullif(trim(p->>'category'),''),'Khác')) limit 1;
  if v_cat is null then select id into v_cat from public.product_categories where name = 'Khác' limit 1; end if;
  insert into public.products(sku, name, category_id, unit, source_type, cost, retail_price, store_share, stock, min_stock)
    values (v_sku, v_name, v_cat, coalesce(nullif(trim(p->>'unit'),''),'cái'), v_src,
            public.tv_num(p->'cost'), public.tv_num(p->'retail_price'), public.tv_num(p->'store_share'), 0, public.tv_num(p->'min_stock'))
    returning id into v_id;
  return jsonb_build_object('ok', true, 'product_id', v_id, 'sku', v_sku);
end $$;

-- 4) TẠO COMBO (định mức BOM) ----------------------------------------
-- p: {name, sku, retail_price, store_share, min_stock, components:[{product_id, qty}]}
create or replace function public.tv_create_combo(p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v_name text := trim(coalesce(p->>'name','')); v_sku text := upper(trim(coalesce(p->>'sku',''))); v_cat uuid; v_id uuid;
  it jsonb; v_cost numeric := 0; v_c public.products; v_q numeric;
begin
  if v_name = '' then raise exception 'Chưa có tên combo'; end if;
  if jsonb_typeof(p->'components') <> 'array' or jsonb_array_length(p->'components') = 0 then raise exception 'Combo chưa có thành phần'; end if;
  if v_sku = '' then v_sku := 'COMBO-' || to_char(now(),'YYMMDDHH24MISS'); end if;
  if exists (select 1 from public.products where upper(sku) = v_sku or lower(name) = lower(v_name)) then raise exception 'Combo "%" / mã "%" đã tồn tại', v_name, v_sku; end if;
  select id into v_cat from public.product_categories where name = 'Combo' limit 1;
  insert into public.products(sku, name, category_id, unit, source_type, cost, retail_price, store_share, stock, min_stock)
    values (v_sku, v_name, v_cat, 'combo', 'combo', 0, public.tv_num(p->'retail_price'), public.tv_num(p->'store_share'), 0, public.tv_num(p->'min_stock'))
    returning id into v_id;
  for it in select * from jsonb_array_elements(p->'components') loop
    select * into v_c from public.products where id = (it->>'product_id')::uuid;
    if not found then raise exception 'Thành phần combo không tồn tại'; end if;
    if v_c.source_type = 'combo' then raise exception 'Không thể lồng combo "%" vào combo khác', v_c.name; end if;
    v_q := public.tv_num(it->'qty', 1);
    if v_q <= 0 then raise exception 'Định mức của "%" phải > 0', v_c.name; end if;
    insert into public.combo_items(combo_product_id, component_product_id, quantity) values (v_id, v_c.id, v_q);
    v_cost := v_cost + v_c.cost * v_q;
  end loop;
  update public.products set cost = v_cost where id = v_id;
  return jsonb_build_object('ok', true, 'product_id', v_id, 'sku', v_sku, 'cost', v_cost);
end $$;

-- 5) ĐÓNG COMBO (trừ vật tư, cộng tồn combo) --------------------------
create or replace function public.tv_build_combo(p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v_combo public.products; v_qty numeric := public.tv_num(p->'qty'); r record; v_c public.products;
begin
  v_combo := public.tv_product_lock((p->>'combo_id')::uuid);
  if v_combo.source_type <> 'combo' then raise exception '"%" không phải combo', v_combo.name; end if;
  if v_qty <= 0 then raise exception 'Số combo cần đóng phải > 0'; end if;
  if not exists (select 1 from public.combo_items where combo_product_id = v_combo.id) then raise exception 'Combo "%" chưa có định mức thành phần', v_combo.name; end if;
  for r in select * from public.combo_items where combo_product_id = v_combo.id order by component_product_id loop
    v_c := public.tv_product_lock(r.component_product_id);
    if v_c.stock < r.quantity * v_qty then
      raise exception 'Không đủ "%" để đóng % combo: cần %, kho còn %', v_c.name, v_qty, r.quantity * v_qty, v_c.stock; end if;
    update public.products set stock = stock - r.quantity * v_qty where id = v_c.id;
    insert into public.stock_movements(product_id, movement_type, quantity, location_type, reference_type, reference_id, note)
      values (v_c.id, 'combo_consume', -(r.quantity * v_qty), 'warehouse', 'combo_build', v_combo.id, 'Đóng ' || v_qty || ' ' || v_combo.name);
  end loop;
  update public.products set stock = stock + v_qty where id = v_combo.id;
  insert into public.stock_movements(product_id, movement_type, quantity, location_type, reference_type, reference_id, note)
    values (v_combo.id, 'combo_build', v_qty, 'warehouse', 'combo_build', v_combo.id, 'Đóng combo');
  return jsonb_build_object('ok', true, 'combo_id', v_combo.id, 'qty', v_qty);
end $$;

-- 6) GIAO KÝ GỬI -----------------------------------------------------
-- p: {store_id, note, auto_build (mặc định true), items:[{product_id, qty}]}
create or replace function public.tv_consign(p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v_store public.stores; v_cid uuid; it jsonb; v_prod public.products; v_qty numeric; v_built jsonb := '[]'::jsonb;
  v_auto boolean := coalesce((p->>'auto_build')::boolean, true); v_need numeric;
begin
  select * into v_store from public.stores where id = (p->>'store_id')::uuid for update;
  if not found then raise exception 'Không tìm thấy cửa hàng'; end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then raise exception 'Chưa có hàng để giao'; end if;
  insert into public.consignments(store_id, note, status) values (v_store.id, p->>'note', 'open') returning id into v_cid;
  for it in select * from jsonb_array_elements(p->'items') loop
    v_prod := public.tv_product_lock((it->>'product_id')::uuid);
    v_qty := public.tv_num(it->'qty');
    if v_qty <= 0 then raise exception 'Số lượng giao "%" phải > 0', v_prod.name; end if;
    if v_prod.stock < v_qty and v_prod.source_type = 'combo' and v_auto then
      v_need := v_qty - v_prod.stock;
      perform public.tv_build_combo(jsonb_build_object('combo_id', v_prod.id, 'qty', v_need));
      v_built := v_built || jsonb_build_object('combo', v_prod.name, 'qty', v_need);
      v_prod := public.tv_product_lock(v_prod.id);
    end if;
    if v_prod.stock < v_qty then raise exception 'Kho không đủ "%": cần %, còn %', v_prod.name, v_qty, v_prod.stock; end if;
    update public.products set stock = stock - v_qty where id = v_prod.id;
    insert into public.consignment_items(consignment_id, product_id, quantity) values (v_cid, v_prod.id, v_qty);
    insert into public.store_inventory(store_id, product_id, quantity) values (v_store.id, v_prod.id, v_qty)
      on conflict (store_id, product_id) do update set quantity = public.store_inventory.quantity + excluded.quantity;
    insert into public.stock_movements(product_id, movement_type, quantity, location_type, location_id, reference_type, reference_id, note)
      values (v_prod.id, 'consign_out', -v_qty, 'store', v_store.id, 'consignment', v_cid, 'Giao ký gửi ' || v_store.name);
  end loop;
  return jsonb_build_object('ok', true, 'consignment_id', v_cid, 'store', v_store.name, 'auto_built', v_built);
end $$;

-- 7) ĐỐI SOÁT --------------------------------------------------------
-- p: {store_id, note, items:[{product_id, sold_qty, broken_qty, returned_qty}]}
create or replace function public.tv_reconcile(p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v_store public.stores; v_rid uuid; it jsonb; v_prod public.products; v_s numeric; v_b numeric; v_r numeric; v_held numeric;
  v_due numeric; v_total numeric := 0;
begin
  select * into v_store from public.stores where id = (p->>'store_id')::uuid for update;
  if not found then raise exception 'Không tìm thấy cửa hàng'; end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then raise exception 'Chưa có dòng đối soát'; end if;
  insert into public.reconciliations(store_id, note) values (v_store.id, p->>'note') returning id into v_rid;
  for it in select * from jsonb_array_elements(p->'items') loop
    v_prod := public.tv_product_lock((it->>'product_id')::uuid);
    v_s := public.tv_num(it->'sold_qty'); v_b := public.tv_num(it->'broken_qty'); v_r := public.tv_num(it->'returned_qty');
    if v_s < 0 or v_b < 0 or v_r < 0 then raise exception 'Số lượng đối soát không được âm'; end if;
    if v_s + v_b + v_r = 0 then continue; end if;
    select quantity into v_held from public.store_inventory where store_id = v_store.id and product_id = v_prod.id for update;
    v_held := coalesce(v_held, 0);
    if v_s + v_b + v_r > v_held then
      raise exception '"%" tại % chỉ còn % (bán % + hỏng % + trả % vượt tồn)', v_prod.name, v_store.name, v_held, v_s, v_b, v_r; end if;
    v_due := v_s * (v_prod.retail_price - v_prod.store_share);
    update public.store_inventory set quantity = quantity - v_s - v_b - v_r where store_id = v_store.id and product_id = v_prod.id;
    insert into public.reconciliation_items(reconciliation_id, product_id, sold_qty, broken_qty, returned_qty, retail_price, store_share, cost, amount_due)
      values (v_rid, v_prod.id, v_s, v_b, v_r, v_prod.retail_price, v_prod.store_share, v_prod.cost, v_due);
    if v_r > 0 then
      update public.products set stock = stock + v_r where id = v_prod.id;
      insert into public.stock_movements(product_id, movement_type, quantity, location_type, location_id, reference_type, reference_id, note)
        values (v_prod.id, 'store_return', v_r, 'warehouse', v_store.id, 'reconciliation', v_rid, 'Trả về từ ' || v_store.name);
    end if;
    if v_s > 0 then insert into public.stock_movements(product_id, movement_type, quantity, location_type, location_id, reference_type, reference_id)
      values (v_prod.id, 'store_sold', -v_s, 'store', v_store.id, 'reconciliation', v_rid); end if;
    if v_b > 0 then insert into public.stock_movements(product_id, movement_type, quantity, location_type, location_id, reference_type, reference_id)
      values (v_prod.id, 'store_broken', -v_b, 'store', v_store.id, 'reconciliation', v_rid); end if;
    v_total := v_total + v_due;
  end loop;
  update public.stores set debt = debt + v_total where id = v_store.id;
  return jsonb_build_object('ok', true, 'reconciliation_id', v_rid, 'amount_due', v_total, 'new_debt', v_store.debt + v_total);
end $$;

-- 8) THU TIỀN --------------------------------------------------------
create or replace function public.tv_record_payment(p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v_store public.stores; v_amt numeric := public.tv_num(p->'amount'); v_m text := coalesce(nullif(p->>'method',''),'cash'); v_id uuid;
begin
  select * into v_store from public.stores where id = (p->>'store_id')::uuid for update;
  if not found then raise exception 'Không tìm thấy cửa hàng'; end if;
  if v_amt <= 0 then raise exception 'Số tiền thu phải > 0'; end if;
  if v_m not in ('cash','bank_transfer','other') then v_m := 'other'; end if;
  if v_amt > v_store.debt then raise exception 'Số tiền thu (%) lớn hơn công nợ hiện tại của % (%)', v_amt, v_store.name, v_store.debt; end if;
  insert into public.payments(store_id, amount, payment_method, note) values (v_store.id, v_amt, v_m, p->>'note') returning id into v_id;
  update public.stores set debt = debt - v_amt where id = v_store.id;
  return jsonb_build_object('ok', true, 'payment_id', v_id, 'new_debt', v_store.debt - v_amt);
end $$;

-- 9) BÀN GIAO KỆ -----------------------------------------------------
create or replace function public.tv_assign_rack(p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v_code text := upper(trim(coalesce(p->>'code',''))); v_store uuid := nullif(p->>'store_id','')::uuid; v_id uuid; v_old public.racks;
begin
  if v_code = '' then raise exception 'Chưa có mã kệ'; end if;
  if v_store is null or not exists (select 1 from public.stores where id = v_store) then raise exception 'Không tìm thấy cửa hàng nhận kệ'; end if;
  select * into v_old from public.racks where upper(code) = v_code for update;
  if found then
    if v_old.status = 'assigned' and v_old.store_id is distinct from v_store then raise exception 'Kệ % đang đặt ở cửa hàng khác, cần thu hồi trước', v_code; end if;
    update public.racks set store_id = v_store, status = 'assigned', assigned_at = now(),
      asset_value = coalesce(nullif(p->>'asset_value','')::numeric, asset_value), deposit = coalesce(nullif(p->>'deposit','')::numeric, deposit),
      note = coalesce(nullif(p->>'note',''), note) where id = v_old.id returning id into v_id;
  else
    insert into public.racks(code, asset_value, deposit, status, store_id, assigned_at, note)
      values (v_code, public.tv_num(p->'asset_value', 600000), public.tv_num(p->'deposit'), 'assigned', v_store, now(), p->>'note') returning id into v_id;
  end if;
  return jsonb_build_object('ok', true, 'rack_id', v_id, 'code', v_code);
end $$;

-- 10) THU HỒI KỆ -----------------------------------------------------
create or replace function public.tv_return_rack(p jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  update public.racks set status = 'warehouse', store_id = null, assigned_at = null where id = (p->>'rack_id')::uuid returning id into v_id;
  if v_id is null then raise exception 'Không tìm thấy kệ'; end if;
  return jsonb_build_object('ok', true, 'rack_id', v_id);
end $$;

-- Quyền: chỉ người đã đăng nhập được gọi
do $$ declare f text; begin
  foreach f in array array['tv_num(jsonb,numeric)','tv_product_lock(uuid)','tv_stock_in(jsonb)','tv_create_store(jsonb)','tv_create_product(jsonb)','tv_create_combo(jsonb)','tv_build_combo(jsonb)','tv_consign(jsonb)','tv_reconcile(jsonb)','tv_record_payment(jsonb)','tv_assign_rack(jsonb)','tv_return_rack(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop; end $$;

notify pgrst, 'reload schema';
