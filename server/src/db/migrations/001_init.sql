-- Core schema for the kiosk / POS / KDS / queue platform.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- organisation
CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name jsonb NOT NULL DEFAULT '{}',
  address text,
  phone text,
  tax_id text,
  timezone text NOT NULL DEFAULT 'Asia/Bangkok',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE languages (
  code text PRIMARY KEY,
  name text NOT NULL,
  native_name text NOT NULL,
  flag text,
  enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  sort int NOT NULL DEFAULT 0,
  overrides jsonb NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX languages_one_default ON languages (is_default) WHERE is_default;

-- ---------------------------------------------------------------- staff & RBAC
CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  level int NOT NULL DEFAULT 10,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  code text PRIMARY KEY,
  name text NOT NULL,
  grp text NOT NULL,
  is_sensitive boolean NOT NULL DEFAULT false
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  nickname text,
  employee_code text NOT NULL UNIQUE,
  username text UNIQUE,
  password_hash text,
  pin_hash text,
  role_id uuid NOT NULL REFERENCES roles(id),
  branch_id uuid REFERENCES branches(id),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','LOCKED')),
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  token_version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- settings / fonts
CREATE TABLE settings (
  scope text NOT NULL DEFAULT 'global',
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE TABLE fonts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family text NOT NULL,
  source text NOT NULL CHECK (source IN ('GOOGLE','UPLOAD','SYSTEM')),
  file_url text,
  format text CHECK (format IN ('ttf','otf','woff','woff2')),
  weights int[] NOT NULL DEFAULT '{400,700}',
  scripts text[] NOT NULL DEFAULT '{latin}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family, source)
);

-- ---------------------------------------------------------------- kitchen / printers / devices
CREATE TABLE kitchen_stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  code text NOT NULL,
  name jsonb NOT NULL DEFAULT '{}',
  color text NOT NULL DEFAULT '#f97316',
  sort int NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, code)
);
CREATE UNIQUE INDEX kitchen_stations_one_default ON kitchen_stations (branch_id) WHERE is_default;

CREATE TABLE print_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'OFFLINE',
  version text,
  hostname text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kiosks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  token_hash text,
  default_language text NOT NULL DEFAULT 'th' REFERENCES languages(code),
  receipt_printer_id uuid,
  theme jsonb NOT NULL DEFAULT '{}',
  idle_timeout int NOT NULL DEFAULT 60 CHECK (idle_timeout BETWEEN 10 AND 3600),
  payment_methods text[] NOT NULL DEFAULT '{QR,CASH,CARD}',
  order_types text[] NOT NULL DEFAULT '{DINE_IN,TAKE_AWAY}',
  is_active boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'OFFLINE',
  app_version text,
  ip text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE printers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('RECEIPT','KITCHEN','BEVERAGE','DESSERT','OTHER')),
  connection text NOT NULL CHECK (connection IN ('USB','BLUETOOTH','BLE','LAN','ETHERNET','WIFI')),
  executor text NOT NULL DEFAULT 'AGENT' CHECK (executor IN ('AGENT','BROWSER','ANDROID','DESKTOP')),
  driver text NOT NULL DEFAULT 'ESCPOS',
  host text,
  port int DEFAULT 9100,
  device_path text,
  device_id text,
  agent_id uuid REFERENCES print_agents(id) ON DELETE SET NULL,
  host_device_id text,
  station_id uuid REFERENCES kitchen_stations(id) ON DELETE SET NULL,
  paper_width int NOT NULL DEFAULT 80 CHECK (paper_width IN (58, 80)),
  dots_per_line int,
  chars_per_line int,
  raster_mode text NOT NULL DEFAULT 'AUTO' CHECK (raster_mode IN ('AUTO','TEXT','RASTER')),
  cut boolean NOT NULL DEFAULT true,
  open_drawer boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  auto_reconnect boolean NOT NULL DEFAULT true,
  is_enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('CONNECTED','OFFLINE','ERROR','UNKNOWN')),
  last_error text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX printers_one_default_per_type ON printers (branch_id, type) WHERE is_default;
ALTER TABLE kiosks ADD CONSTRAINT kiosks_receipt_printer_fk FOREIGN KEY (receipt_printer_id) REFERENCES printers(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- menu
CREATE TABLE menu_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  days int[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'STANDARD' CHECK (kind IN ('STANDARD','RECOMMENDED','PROMOTION')),
  name jsonb NOT NULL DEFAULT '{}',
  image_url text,
  icon text,
  sort int NOT NULL DEFAULT 0,
  station_id uuid REFERENCES kitchen_stations(id) ON DELETE SET NULL,
  printer_id uuid REFERENCES printers(id) ON DELETE SET NULL,
  schedule_id uuid REFERENCES menu_schedules(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE,
  barcode text,
  category_id uuid NOT NULL REFERENCES categories(id),
  image_url text,
  price numeric(12,2) NOT NULL CHECK (price >= 0),
  cost numeric(12,2) NOT NULL DEFAULT 0,
  vat_rate numeric(5,2),
  station_id uuid REFERENCES kitchen_stations(id) ON DELETE SET NULL,
  printer_id uuid REFERENCES printers(id) ON DELETE SET NULL,
  schedule_id uuid REFERENCES menu_schedules(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','SOLD_OUT','UNAVAILABLE','HIDDEN')),
  is_recommended boolean NOT NULL DEFAULT false,
  track_stock boolean NOT NULL DEFAULT false,
  sort int NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_category ON products (category_id) WHERE deleted_at IS NULL;

CREATE TABLE product_translations (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  lang text NOT NULL REFERENCES languages(code) ON DELETE CASCADE,
  name text NOT NULL,
  short_description text,
  description text,
  PRIMARY KEY (product_id, lang)
);

CREATE TABLE modifier_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name jsonb NOT NULL DEFAULT '{}',
  selection text NOT NULL DEFAULT 'SINGLE' CHECK (selection IN ('SINGLE','MULTIPLE')),
  kind text NOT NULL DEFAULT 'OPTION' CHECK (kind IN ('OPTION','ADD','REMOVE','EXTRA')),
  required boolean NOT NULL DEFAULT false,
  min_select int NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select int NOT NULL DEFAULT 1 CHECK (max_select >= 0),
  sort int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name jsonb NOT NULL DEFAULT '{}',
  price_delta numeric(12,2) NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_modifier_groups (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  sort int NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, group_id)
);

CREATE TABLE product_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  recommended_product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  message jsonb NOT NULL DEFAULT '{}',
  special_price numeric(12,2),
  sort int NOT NULL DEFAULT 0,
  UNIQUE (product_id, recommended_product_id),
  CHECK (product_id <> recommended_product_id)
);

-- ---------------------------------------------------------------- promotions
CREATE TABLE promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text,
  name jsonb NOT NULL DEFAULT '{}',
  description jsonb NOT NULL DEFAULT '{}',
  badge jsonb NOT NULL DEFAULT '{}',
  type text NOT NULL CHECK (type IN ('PERCENT','FIXED','BUY_X_GET_Y','COMBO','SET_MENU','COUPON','PROMO_CODE')),
  value_type text NOT NULL DEFAULT 'PERCENT' CHECK (value_type IN ('PERCENT','FIXED')),
  value numeric(12,2) NOT NULL DEFAULT 0,
  buy_qty int,
  get_qty int,
  combo_price numeric(12,2),
  min_order numeric(12,2),
  max_discount numeric(12,2),
  scope text NOT NULL DEFAULT 'ORDER' CHECK (scope IN ('ORDER','PRODUCT','CATEGORY')),
  product_ids uuid[] NOT NULL DEFAULT '{}',
  category_ids uuid[] NOT NULL DEFAULT '{}',
  branch_ids uuid[] NOT NULL DEFAULT '{}',
  start_date date,
  end_date date,
  start_time time,
  end_time time,
  days int[] NOT NULL DEFAULT '{}',
  usage_limit int,
  usage_count int NOT NULL DEFAULT 0,
  requires_code boolean NOT NULL DEFAULT false,
  priority int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX promotions_code_unique ON promotions (upper(code)) WHERE code IS NOT NULL;

-- ---------------------------------------------------------------- stock
CREATE TABLE stocks (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  current numeric(12,2) NOT NULL DEFAULT 0,
  reserved numeric(12,2) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  minimum numeric(12,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, branch_id)
);

-- ---------------------------------------------------------------- orders
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id),
  kiosk_id uuid REFERENCES kiosks(id) ON DELETE SET NULL,
  client_order_id uuid UNIQUE,
  order_number char(5) NOT NULL CHECK (order_number ~ '^[0-9]{5}$'),
  order_type text NOT NULL CHECK (order_type IN ('DINE_IN','TAKE_AWAY')),
  status text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','WAITING_PAYMENT','WAITING_CASH_PAYMENT','WAITING_CARD','WAITING_VERIFICATION','PAID','CONFIRMED','NEW','PREPARING','READY','COMPLETED','CANCELLED','REFUNDED')),
  payment_status text NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID','PENDING','PAID','REFUNDED','PARTIALLY_REFUNDED','VOID')),
  payment_method text CHECK (payment_method IN ('QR','CASH','CARD','OTHER')),
  language text NOT NULL DEFAULT 'th',
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  discount numeric(12,2) NOT NULL DEFAULT 0,
  service_charge numeric(12,2) NOT NULL DEFAULT 0,
  vat numeric(12,2) NOT NULL DEFAULT 0,
  total numeric(12,2) NOT NULL DEFAULT 0,
  refunded_amount numeric(12,2) NOT NULL DEFAULT 0,
  vat_mode text NOT NULL DEFAULT 'INCLUDED',
  vat_rate numeric(5,2) NOT NULL DEFAULT 7,
  service_charge_rate numeric(5,2) NOT NULL DEFAULT 0,
  promo_code text,
  applied_promotions jsonb NOT NULL DEFAULT '[]',
  note text,
  source text NOT NULL DEFAULT 'KIOSK' CHECK (source IN ('KIOSK','CASHIER')),
  offline_ref text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  paid_at timestamptz,
  confirmed_at timestamptz,
  preparing_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  expires_at timestamptz,
  version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_branch_status ON orders (branch_id, status);
CREATE INDEX orders_branch_created ON orders (branch_id, created_at DESC);
CREATE INDEX orders_number ON orders (order_number);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  sku text,
  name jsonb NOT NULL,
  base_price numeric(12,2) NOT NULL,
  unit_price numeric(12,2) NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  line_total numeric(12,2) NOT NULL,
  discount numeric(12,2) NOT NULL DEFAULT 0,
  cost numeric(12,2) NOT NULL DEFAULT 0,
  station_id uuid REFERENCES kitchen_stations(id) ON DELETE SET NULL,
  printer_id uuid REFERENCES printers(id) ON DELETE SET NULL,
  special_request text,
  sort int NOT NULL DEFAULT 0
);
CREATE INDEX order_items_order ON order_items (order_id);
CREATE INDEX order_items_product ON order_items (product_id);

CREATE TABLE order_item_modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  modifier_id uuid REFERENCES modifiers(id) ON DELETE SET NULL,
  group_id uuid REFERENCES modifier_groups(id) ON DELETE SET NULL,
  name jsonb NOT NULL,
  group_name jsonb NOT NULL DEFAULT '{}',
  kind text NOT NULL DEFAULT 'OPTION',
  price_delta numeric(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX order_item_modifiers_item ON order_item_modifiers (order_item_id);

-- Timeline for audit / troubleshooting (Order Detail screen).
CREATE TABLE order_events (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  actor_type text NOT NULL DEFAULT 'SYSTEM' CHECK (actor_type IN ('KIOSK','STAFF','SYSTEM','PROVIDER','CUSTOMER')),
  actor_id text,
  actor_name text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX order_events_order ON order_events (order_id, id);

-- Customer queue numbers: random 5 digits, unique among *active* orders of a branch.
CREATE TABLE queue_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  number char(5) NOT NULL CHECK (number ~ '^[0-9]{5}$'),
  status text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','PREPARING','READY','COMPLETED','CANCELLED')),
  active boolean NOT NULL DEFAULT true,
  call_count int NOT NULL DEFAULT 0,
  last_called_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE UNIQUE INDEX queue_numbers_active_unique ON queue_numbers (branch_id, number) WHERE active;
CREATE INDEX queue_numbers_display ON queue_numbers (branch_id, status) WHERE active;

-- ---------------------------------------------------------------- payments
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('QR','CASH','CARD','OTHER')),
  provider text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','WAITING_VERIFICATION','WAITING_CASH','WAITING_CARD','PROCESSING','APPROVED','PAID','DECLINED','REJECTED','CANCELLED','EXPIRED','REFUNDED')),
  amount numeric(12,2) NOT NULL,
  received_amount numeric(12,2),
  change_amount numeric(12,2),
  currency text NOT NULL DEFAULT 'THB',
  reference text,
  provider_txn_id text,
  qr_payload text,
  card_brand text,
  card_last4 text CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  approval_code text,
  idempotency_key text UNIQUE,
  expires_at timestamptz,
  paid_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- DB-level guard against double payment: at most one PAID payment per order.
CREATE UNIQUE INDEX payments_one_paid_per_order ON payments (order_id) WHERE status = 'PAID';
CREATE UNIQUE INDEX payments_provider_txn ON payments (provider, provider_txn_id) WHERE provider_txn_id IS NOT NULL;
CREATE INDEX payments_order ON payments (order_id);

CREATE TABLE payment_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kiosk_id uuid REFERENCES kiosks(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'WAITING_VERIFICATION' CHECK (status IN ('WAITING_VERIFICATION','APPROVED','REJECTED','CANCELLED')),
  expected_amount numeric(12,2) NOT NULL,
  paid_amount numeric(12,2),
  payment_time timestamptz,
  customer_reference text,
  slip_url text,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  reason text,
  requested_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_verifications_one_open ON payment_verifications (order_id) WHERE status = 'WAITING_VERIFICATION';

CREATE TABLE payment_webhook_events (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  event_id text NOT NULL,
  signature_valid boolean NOT NULL,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  method text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- kitchen
CREATE TABLE kitchen_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  station_id uuid NOT NULL REFERENCES kitchen_stations(id),
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','PREPARING','READY','DONE','CANCELLED')),
  started_at timestamptz,
  ready_at timestamptz,
  done_at timestamptz,
  started_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, station_id)
);
CREATE INDEX kitchen_orders_active ON kitchen_orders (branch_id, status);

-- ---------------------------------------------------------------- printing
CREATE TABLE print_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
  order_number char(5),
  printer_id uuid REFERENCES printers(id) ON DELETE SET NULL,
  station_id uuid REFERENCES kitchen_stations(id) ON DELETE SET NULL,
  document_type text NOT NULL CHECK (document_type IN ('RECEIPT','KITCHEN_TICKET','TEST')),
  copy_no int NOT NULL DEFAULT 1,
  is_reprint boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','PRINTING','PRINTED','FAILED','RETRYING','CANCELLED')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  last_error text,
  claimed_by text,
  claimed_at timestamptz,
  next_retry_at timestamptz,
  printed_at timestamptz,
  -- Unique per logical document so replayed events / retries can never create a second ticket.
  dedupe_key text NOT NULL UNIQUE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX print_jobs_pending ON print_jobs (printer_id, status) WHERE status IN ('QUEUED','RETRYING','PRINTING');
CREATE INDEX print_jobs_order ON print_jobs (order_id);

-- ---------------------------------------------------------------- stock movements
CREATE TABLE stock_movements (
  id bigserial PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('RESERVE','RELEASE','COMMIT','ADJUST','RESTOCK','WASTE','RETURN')),
  qty numeric(12,2) NOT NULL,
  current_after numeric(12,2),
  reserved_after numeric(12,2),
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_product ON stock_movements (product_id, created_at DESC);
-- One commit / reserve / release per order+product so retries cannot double-deduct stock.
CREATE UNIQUE INDEX stock_movements_order_once ON stock_movements (order_id, product_id, type)
  WHERE order_id IS NOT NULL AND type IN ('RESERVE','RELEASE','COMMIT','RETURN');

-- ---------------------------------------------------------------- audit & idempotency
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  user_name text,
  role text,
  action text NOT NULL,
  entity text,
  entity_id text,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  old_value jsonb,
  new_value jsonb,
  ip text,
  device text,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_action ON audit_logs (action);

CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code int,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branches','roles','users','kitchen_stations','kiosks','printers','categories','products',
    'modifier_groups','promotions','orders','payments','kitchen_orders','print_jobs','queue_numbers'] LOOP
    EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t, t);
  END LOOP;
END $$;
