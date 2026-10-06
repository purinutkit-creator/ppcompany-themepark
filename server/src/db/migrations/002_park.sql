-- Theme park / FEC platform: credentials, members, wallet ledger, tickets & packages, bookings, universal sales,
-- gates, rides, queues, lockers, retail inventory, shifts, devices, notifications.
-- Design notes:
--   * One customer_account owns ONE wallet; every credential (member card, digital card, wristband, QR ticket)
--     points at an account, so all credentials of a person see the same balance (no parallel wallets).
--   * QR / barcode content is "<credential code>.<HMAC signature>" — never balances or personal data.
--   * Money movements are ledger rows with balance_before/after; balances are only changed inside the same
--     transaction that inserts the ledger row (CHECK constraint keeps them consistent).

-- ---------------------------------------------------------------- helpers
CREATE TABLE daily_counters (
  scope text NOT NULL,
  day date NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, day)
);
CREATE SEQUENCE member_no_seq START 1000;
CREATE SEQUENCE card_no_seq START 1000;
CREATE SEQUENCE wristband_no_seq START 1000;

ALTER TABLE branches ADD COLUMN config jsonb NOT NULL DEFAULT '{}';
ALTER TABLE branches ADD COLUMN logo_url text;

-- ---------------------------------------------------------------- zones
CREATE TABLE zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  code text NOT NULL,
  name jsonb NOT NULL DEFAULT '{}',
  color text NOT NULL DEFAULT '#22c55e',
  capacity int NOT NULL DEFAULT 0 CHECK (capacity >= 0),
  map jsonb NOT NULL DEFAULT '{"x":0,"y":0,"w":20,"h":20}',
  sort int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, code)
);

-- ---------------------------------------------------------------- devices (gate scanners, controllers, POS, displays…)
CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('GATE_SCANNER','GATE_CONTROLLER','GATE_DISPLAY','POS','COUNTER','KIOSK','RIDE_SCANNER',
    'KITCHEN_DISPLAY','QUEUE_DISPLAY','LOCKER_CONTROLLER','EDGE_AGENT','OTHER')),
  location text,
  zone_id uuid REFERENCES zones(id) ON DELETE SET NULL,
  token_hash text,
  ip text,
  app_version text,
  status text NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('ONLINE','OFFLINE','ERROR')),
  last_error text,
  last_seen_at timestamptz,
  config jsonb NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_branch ON devices (branch_id, type);

-- ---------------------------------------------------------------- stores (restaurant / retail / locker / service / warehouse)
CREATE TABLE stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  code text NOT NULL,
  name jsonb NOT NULL DEFAULT '{}',
  type text NOT NULL CHECK (type IN ('RESTAURANT','RETAIL','LOCKER','SERVICE','TICKETING','WAREHOUSE')),
  zone_id uuid REFERENCES zones(id) ON DELETE SET NULL,
  receipt_printer_id uuid REFERENCES printers(id) ON DELETE SET NULL,
  category_ids uuid[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, code)
);

-- Product catalog is shared with the restaurant module; categories get a sales channel.
ALTER TABLE categories ADD COLUMN channel text NOT NULL DEFAULT 'FOOD' CHECK (channel IN ('FOOD','RETAIL','SERVICE'));
ALTER TABLE products ADD COLUMN product_type text NOT NULL DEFAULT 'FOOD'
  CHECK (product_type IN ('FOOD','DRINK','SOUVENIR','MERCHANDISE','PHOTO','LOCKER','SERVICE','OTHER'));
CREATE UNIQUE INDEX products_barcode_unique ON products (barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------- customers, members, tiers, memberships
CREATE TABLE customer_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'GUEST' CHECK (kind IN ('MEMBER','GUEST')),
  display_name text,
  phone text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE member_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name jsonb NOT NULL DEFAULT '{}',
  rank int NOT NULL DEFAULT 0,
  color text NOT NULL DEFAULT '#64748b',
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX member_tiers_one_default ON member_tiers (is_default) WHERE is_default;

CREATE TABLE membership_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  tier_id uuid NOT NULL REFERENCES member_tiers(id),
  name jsonb NOT NULL DEFAULT '{}',
  description jsonb NOT NULL DEFAULT '{}',
  image_url text,
  card_design jsonb NOT NULL DEFAULT '{}',
  registration_fee numeric(12,2) NOT NULL DEFAULT 0 CHECK (registration_fee >= 0),
  price numeric(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  validity_unit text NOT NULL DEFAULT 'YEAR' CHECK (validity_unit IN ('DAY','MONTH','YEAR','LIFETIME')),
  validity_value int NOT NULL DEFAULT 1 CHECK (validity_value > 0),
  renewal_price numeric(12,2),
  early_renewal_days int NOT NULL DEFAULT 30,
  early_renewal_discount_pct numeric(5,2) NOT NULL DEFAULT 0,
  grace_days int NOT NULL DEFAULT 0,
  upgrade_mode text NOT NULL DEFAULT 'DIFFERENCE' CHECK (upgrade_mode IN ('FULL','DIFFERENCE','PRORATED')),
  upgrade_price numeric(12,2),
  point_multiplier numeric(6,2) NOT NULL DEFAULT 1,
  visit_limit int,
  channels text[] NOT NULL DEFAULT '{ONLINE,COUNTER,KIOSK}',
  sort int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE membership_benefits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES membership_products(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('TICKET_DISCOUNT','FOOD_DISCOUNT','RETAIL_DISCOUNT','LOCKER_DISCOUNT','RIDE_DISCOUNT','FREE_RIDE','FREE_LOCKER',
    'BIRTHDAY_REWARD','PRIORITY_QUEUE','FAST_PASS','FREE_ADMISSION','GUEST_DISCOUNT','POINT_MULTIPLIER','PARKING','SPECIAL_EVENT','LOUNGE','CUSTOM')),
  value numeric(12,2) NOT NULL DEFAULT 0,
  name jsonb NOT NULL DEFAULT '{}',
  config jsonb NOT NULL DEFAULT '{}',
  sort int NOT NULL DEFAULT 0
);
CREATE INDEX membership_benefits_product ON membership_benefits (product_id);

CREATE TABLE members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_no text NOT NULL UNIQUE,
  account_id uuid NOT NULL UNIQUE REFERENCES customer_accounts(id),
  first_name text NOT NULL,
  last_name text NOT NULL DEFAULT '',
  phone text NOT NULL,
  email text,
  password_hash text,
  birthday date,
  gender text CHECK (gender IS NULL OR gender IN ('MALE','FEMALE','OTHER','UNSPECIFIED')),
  address text,
  emergency_contact text,
  tier_id uuid REFERENCES member_tiers(id),
  points int NOT NULL DEFAULT 0 CHECK (points >= 0),
  total_spend numeric(14,2) NOT NULL DEFAULT 0,
  visit_count int NOT NULL DEFAULT 0,
  last_visit_date date,
  home_branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  created_via text NOT NULL DEFAULT 'ONLINE' CHECK (created_via IN ('ONLINE','COUNTER','KIOSK','IMPORT')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  phone_verified boolean NOT NULL DEFAULT false,
  email_verified boolean NOT NULL DEFAULT false,
  language text NOT NULL DEFAULT 'th',
  token_version int NOT NULL DEFAULT 0,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  last_login_ip text,
  join_date date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX members_phone_unique ON members (phone);
CREATE UNIQUE INDEX members_email_unique ON members (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX members_name ON members (lower(first_name), lower(last_name));

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES membership_products(id),
  tier_id uuid NOT NULL REFERENCES member_tiers(id),
  kind text NOT NULL DEFAULT 'NEW' CHECK (kind IN ('NEW','RENEWAL','UPGRADE','COMP')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('PENDING','ACTIVE','EXPIRED','CANCELLED','UPGRADED','REFUNDED')),
  start_date date NOT NULL,
  end_date date,
  sale_id uuid,
  price numeric(12,2) NOT NULL DEFAULT 0,
  reminded_days int[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memberships_member ON memberships (member_id, status);
CREATE INDEX memberships_expiry ON memberships (end_date) WHERE status = 'ACTIVE';

CREATE TABLE member_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('REGISTER','LOGIN','RESET_PASSWORD','VERIFY')),
  code_hash text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX member_otps_target ON member_otps (target, purpose, created_at DESC);

CREATE TABLE member_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  ip text,
  user_agent text,
  suspicious boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX member_sessions_member ON member_sessions (member_id, created_at DESC);

-- ---------------------------------------------------------------- wallet (ledger based)
CREATE TABLE wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL UNIQUE REFERENCES customer_accounts(id) ON DELETE CASCADE,
  balance numeric(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  -- Promotional / package credit (non-refundable) included in balance; spent first.
  bonus_balance numeric(12,2) NOT NULL DEFAULT 0 CHECK (bonus_balance >= 0),
  currency text NOT NULL DEFAULT 'THB',
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FROZEN','CLOSED')),
  version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (bonus_balance <= balance)
);

CREATE TABLE wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial UNIQUE,
  txn_no text NOT NULL UNIQUE,
  wallet_id uuid NOT NULL REFERENCES wallet_accounts(id),
  account_id uuid NOT NULL REFERENCES customer_accounts(id),
  credential_id uuid,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('TOPUP','PAYMENT','REFUND','ADJUSTMENT','TRANSFER_IN','TRANSFER_OUT','BONUS','REVERSAL','CASHOUT','EXPIRE')),
  debit numeric(12,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(12,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  balance_before numeric(12,2) NOT NULL,
  balance_after numeric(12,2) NOT NULL CHECK (balance_after >= 0),
  bonus_before numeric(12,2) NOT NULL DEFAULT 0,
  bonus_after numeric(12,2) NOT NULL DEFAULT 0,
  reference text,
  ref_type text,
  ref_id uuid,
  store_id uuid REFERENCES stores(id) ON DELETE SET NULL,
  device_id text,
  staff_id uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key text UNIQUE,
  note text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (balance_after = balance_before + credit - debit),
  CHECK ((debit > 0) <> (credit > 0))
);
CREATE INDEX wallet_ledger_wallet ON wallet_ledger (wallet_id, seq DESC);
CREATE INDEX wallet_ledger_ref ON wallet_ledger (ref_type, ref_id);
CREATE INDEX wallet_ledger_created ON wallet_ledger (created_at DESC);

CREATE TABLE points_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('EARN','REDEEM','ADJUST','EXPIRE','REVERSE','PAYMENT')),
  points int NOT NULL CHECK (points <> 0),
  balance_before int NOT NULL,
  balance_after int NOT NULL CHECK (balance_after >= 0),
  reference text,
  ref_type text,
  ref_id uuid,
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  staff_id uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key text UNIQUE,
  note text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (balance_after = balance_before + points)
);
CREATE INDEX points_ledger_member ON points_ledger (member_id, created_at DESC);

-- ---------------------------------------------------------------- ticket types & packages
CREATE TABLE ticket_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name jsonb NOT NULL DEFAULT '{}',
  description jsonb NOT NULL DEFAULT '{}',
  min_age int,
  max_age int,
  min_height int,
  max_height int,
  requires_proof boolean NOT NULL DEFAULT false,
  color text NOT NULL DEFAULT '#0ea5e9',
  sort int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  kind text NOT NULL DEFAULT 'ADMISSION' CHECK (kind IN ('ADMISSION','ADDON','RIDE_PASS','FAST_PASS','LOCKER','FOOD_VOUCHER','WALLET_CREDIT','EVENT')),
  name jsonb NOT NULL DEFAULT '{}',
  description jsonb NOT NULL DEFAULT '{}',
  terms jsonb NOT NULL DEFAULT '{}',
  image_url text,
  color text NOT NULL DEFAULT '#6366f1',
  branch_ids uuid[] NOT NULL DEFAULT '{}',
  channels text[] NOT NULL DEFAULT '{ONLINE,COUNTER,KIOSK}',
  base_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (base_price >= 0),
  days int NOT NULL DEFAULT 1 CHECK (days >= 1),
  usage_mode text NOT NULL DEFAULT 'FIXED_DATES' CHECK (usage_mode IN ('FIXED_DATES','FLEX_DAYS')),
  flex_window_days int NOT NULL DEFAULT 1 CHECK (flex_window_days >= 1),
  entries_per_day int,
  reentry boolean NOT NULL DEFAULT true,
  transferable boolean NOT NULL DEFAULT false,
  sale_from date,
  sale_to date,
  valid_days int[] NOT NULL DEFAULT '{}',
  time_start time,
  time_end time,
  blackout_dates date[] NOT NULL DEFAULT '{}',
  daily_capacity int,
  min_qty int NOT NULL DEFAULT 1,
  max_qty int NOT NULL DEFAULT 20,
  guests_per_unit int NOT NULL DEFAULT 1 CHECK (guests_per_unit >= 1),
  bundle jsonb NOT NULL DEFAULT '{}',
  all_rides boolean NOT NULL DEFAULT false,
  all_rides_type text NOT NULL DEFAULT 'UNLIMITED' CHECK (all_rides_type IN ('ONE_TIME','MULTI_USE','UNLIMITED','TIME_BASED','DATE_BASED')),
  all_rides_uses int,
  zone_ids uuid[] NOT NULL DEFAULT '{}',
  refund_policy text NOT NULL DEFAULT 'NON_REFUNDABLE' CHECK (refund_policy IN ('NON_REFUNDABLE','FULL_BEFORE_VISIT','PARTIAL_BEFORE_VISIT','ANYTIME')),
  refund_cutoff_hours int NOT NULL DEFAULT 24,
  refund_fee_pct numeric(5,2) NOT NULL DEFAULT 0,
  member_only boolean NOT NULL DEFAULT false,
  tier_ids uuid[] NOT NULL DEFAULT '{}',
  points_eligible boolean NOT NULL DEFAULT true,
  requires_visit_date boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE package_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  ticket_type_id uuid REFERENCES ticket_types(id) ON DELETE CASCADE,
  price numeric(12,2) NOT NULL CHECK (price >= 0),
  member_price numeric(12,2),
  weekend_price numeric(12,2),
  tier_prices jsonb NOT NULL DEFAULT '{}',
  UNIQUE NULLS NOT DISTINCT (package_id, ticket_type_id)
);

CREATE TABLE package_benefits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('FOOD_VOUCHER','LOCKER','FAST_PASS','WALLET_CREDIT','PHOTO','COUPON','CUSTOM')),
  value numeric(12,2) NOT NULL DEFAULT 0,
  qty int NOT NULL DEFAULT 1,
  name jsonb NOT NULL DEFAULT '{}',
  config jsonb NOT NULL DEFAULT '{}'
);

-- ---------------------------------------------------------------- rides
CREATE TABLE rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  code text NOT NULL,
  name jsonb NOT NULL DEFAULT '{}',
  description jsonb NOT NULL DEFAULT '{}',
  image_url text,
  zone_id uuid REFERENCES zones(id) ON DELETE SET NULL,
  min_height int,
  max_height int,
  min_age int,
  max_age int,
  capacity int NOT NULL DEFAULT 10 CHECK (capacity > 0),
  duration_minutes numeric(6,2) NOT NULL DEFAULT 5 CHECK (duration_minutes > 0),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','MAINTENANCE','TEMPORARILY_CLOSED')),
  entry_paused boolean NOT NULL DEFAULT false,
  ticket_required boolean NOT NULL DEFAULT true,
  addon_enabled boolean NOT NULL DEFAULT true,
  addon_price numeric(12,2),
  member_price numeric(12,2),
  peak_price numeric(12,2),
  tier_prices jsonb NOT NULL DEFAULT '{}',
  addon_type text NOT NULL DEFAULT 'ONE_TIME' CHECK (addon_type IN ('ONE_TIME','MULTI_USE','UNLIMITED','TIME_BASED','DATE_BASED')),
  addon_uses int NOT NULL DEFAULT 1,
  addon_valid_minutes int,
  point_cost int,
  queue_enabled boolean NOT NULL DEFAULT false,
  queue_prefix text NOT NULL DEFAULT 'A',
  operator_id uuid REFERENCES users(id) ON DELETE SET NULL,
  map jsonb NOT NULL DEFAULT '{"x":50,"y":50}',
  sort int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, code)
);

CREATE TABLE package_rides (
  package_id uuid NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  ride_id uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  entitlement_type text NOT NULL DEFAULT 'UNLIMITED' CHECK (entitlement_type IN ('ONE_TIME','MULTI_USE','UNLIMITED','TIME_BASED','DATE_BASED')),
  uses int,
  PRIMARY KEY (package_id, ride_id)
);

CREATE TABLE ride_scan_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  ride_id uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  zone_id uuid REFERENCES zones(id) ON DELETE SET NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  location text,
  mode text NOT NULL DEFAULT 'ENTRY' CHECK (mode IN ('ENTRY','QUEUE','BOTH')),
  payment_enabled boolean NOT NULL DEFAULT true,
  payment_methods text[] NOT NULL DEFAULT '{WALLET,PROMPTPAY,CARD,CASH}',
  operator_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  last_scan_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- universal sales (tickets, packages, membership, top-up, retail, locker, ride add-on)
CREATE TABLE sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_no text NOT NULL UNIQUE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  store_id uuid REFERENCES stores(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('ONLINE','PORTAL','COUNTER','KIOSK','POS','RIDE','LOCKER','SYSTEM')),
  kind text NOT NULL CHECK (kind IN ('BOOKING','TICKET','MEMBERSHIP','TOPUP','RETAIL','LOCKER','RIDE_ADDON','MIXED')),
  account_id uuid REFERENCES customer_accounts(id) ON DELETE SET NULL,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  credential_id uuid,
  customer_name text,
  phone text,
  email text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PENDING_PAYMENT','PAID','PARTIALLY_REFUNDED','REFUNDED','CANCELLED','VOID','EXPIRED')),
  fulfil_status text NOT NULL DEFAULT 'PENDING' CHECK (fulfil_status IN ('PENDING','DONE','FAILED')),
  fulfil_error text,
  fulfil_attempts int NOT NULL DEFAULT 0,
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  discount numeric(12,2) NOT NULL DEFAULT 0,
  vat numeric(12,2) NOT NULL DEFAULT 0,
  vat_rate numeric(5,2) NOT NULL DEFAULT 7,
  total numeric(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  paid_amount numeric(12,2) NOT NULL DEFAULT 0,
  refunded_amount numeric(12,2) NOT NULL DEFAULT 0,
  points_earned int NOT NULL DEFAULT 0,
  points_redeemed int NOT NULL DEFAULT 0,
  applied_promotions jsonb NOT NULL DEFAULT '[]',
  coupon_codes text[] NOT NULL DEFAULT '{}',
  language text NOT NULL DEFAULT 'th',
  shift_id uuid,
  device_id text,
  printer_id uuid REFERENCES printers(id) ON DELETE SET NULL,
  client_ref text UNIQUE,
  note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  paid_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_branch_created ON sales (branch_id, created_at DESC);
CREATE INDEX sales_member ON sales (member_id);
CREATE INDEX sales_account ON sales (account_id);
CREATE INDEX sales_status ON sales (status) WHERE status IN ('OPEN','PENDING_PAYMENT');
CREATE INDEX sales_fulfil ON sales (fulfil_status) WHERE fulfil_status = 'FAILED';

CREATE TABLE sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  item_type text NOT NULL CHECK (item_type IN ('PACKAGE','MEMBERSHIP','MEMBERSHIP_RENEWAL','MEMBERSHIP_UPGRADE','TOPUP','PRODUCT','LOCKER','RIDE_ADDON','SERVICE')),
  ref_id uuid,
  sku text,
  name jsonb NOT NULL DEFAULT '{}',
  qty int NOT NULL CHECK (qty > 0),
  base_price numeric(12,2) NOT NULL DEFAULT 0,
  unit_price numeric(12,2) NOT NULL,
  discount numeric(12,2) NOT NULL DEFAULT 0,
  line_total numeric(12,2) NOT NULL,
  points_category text NOT NULL DEFAULT 'OTHER',
  meta jsonb NOT NULL DEFAULT '{}',
  fulfilled_at timestamptz,
  refunded_qty int NOT NULL DEFAULT 0,
  sort int NOT NULL DEFAULT 0
);
CREATE INDEX sale_items_sale ON sale_items (sale_id);
CREATE INDEX sale_items_ref ON sale_items (item_type, ref_id);

CREATE TABLE sale_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_no text NOT NULL UNIQUE,
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('CASH','PROMPTPAY','CARD','EWALLET','BANK_TRANSFER','MOBILE_BANKING','WALLET','POINTS','VOUCHER','COMP')),
  provider text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','WAITING_VERIFICATION','WAITING_CASH','WAITING_CARD','PROCESSING','PAID','FAILED','DECLINED','REJECTED','CANCELLED','EXPIRED','REFUNDED','PARTIALLY_REFUNDED')),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  received_amount numeric(12,2),
  change_amount numeric(12,2),
  currency text NOT NULL DEFAULT 'THB',
  reference text,
  provider_txn_id text,
  qr_payload text,
  card_brand text,
  card_last4 text CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  approval_code text,
  wallet_ledger_id uuid REFERENCES wallet_ledger(id),
  points_used int,
  idempotency_key text UNIQUE,
  channel text,
  cashier_id uuid REFERENCES users(id) ON DELETE SET NULL,
  shift_id uuid,
  device_id text,
  refunded_amount numeric(12,2) NOT NULL DEFAULT 0,
  expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sale_payments_sale ON sale_payments (sale_id);
CREATE UNIQUE INDEX sale_payments_provider_txn ON sale_payments (provider, provider_txn_id) WHERE provider_txn_id IS NOT NULL;
CREATE INDEX sale_payments_paid ON sale_payments (paid_at DESC) WHERE status = 'PAID';

CREATE TABLE payment_verification_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  sale_id uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  sale_payment_id uuid NOT NULL REFERENCES sale_payments(id) ON DELETE CASCADE,
  booking_id uuid,
  status text NOT NULL DEFAULT 'WAITING_VERIFICATION' CHECK (status IN ('WAITING_VERIFICATION','APPROVED','REJECTED','NEW_SLIP_REQUESTED','CANCELLED')),
  method text NOT NULL,
  expected_amount numeric(12,2) NOT NULL,
  paid_amount numeric(12,2),
  payment_time timestamptz,
  slip_url text,
  reference text,
  customer_name text,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  reason text,
  requested_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pvr_one_open ON payment_verification_requests (sale_payment_id) WHERE status = 'WAITING_VERIFICATION';
CREATE INDEX pvr_branch_status ON payment_verification_requests (branch_id, status);

-- Refunds become universal (restaurant orders OR park sales).
ALTER TABLE refunds ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE refunds ADD COLUMN refund_no text UNIQUE;
ALTER TABLE refunds ADD COLUMN sale_id uuid REFERENCES sales(id) ON DELETE CASCADE;
ALTER TABLE refunds ADD COLUMN sale_payment_id uuid REFERENCES sale_payments(id) ON DELETE SET NULL;
ALTER TABLE refunds ADD COLUMN branch_id uuid REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE refunds ADD COLUMN type text NOT NULL DEFAULT 'PARTIAL' CHECK (type IN ('FULL','PARTIAL','WALLET','TICKET','POS'));
ALTER TABLE refunds ADD COLUMN refund_method text;
ALTER TABLE refunds ADD COLUMN items jsonb NOT NULL DEFAULT '[]';
ALTER TABLE refunds ADD COLUMN wallet_ledger_id uuid REFERENCES wallet_ledger(id);
ALTER TABLE refunds ADD COLUMN shift_id uuid;
ALTER TABLE refunds ADD CONSTRAINT refunds_target CHECK (order_id IS NOT NULL OR sale_id IS NOT NULL OR wallet_ledger_id IS NOT NULL);
CREATE INDEX refunds_sale ON refunds (sale_id);

-- ---------------------------------------------------------------- bookings & tickets
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_no text NOT NULL UNIQUE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  sale_id uuid NOT NULL UNIQUE REFERENCES sales(id),
  account_id uuid REFERENCES customer_accounts(id) ON DELETE SET NULL,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  channel text NOT NULL,
  customer_name text NOT NULL,
  phone text,
  email text,
  visit_date date NOT NULL,
  guests int NOT NULL DEFAULT 1 CHECK (guests > 0),
  pay_mode text NOT NULL DEFAULT 'PAY_NOW' CHECK (pay_mode IN ('PAY_NOW','PAY_AT_PARK')),
  status text NOT NULL DEFAULT 'PENDING_PAYMENT' CHECK (status IN ('PENDING_PAYMENT','RESERVED','WAITING_VERIFICATION','CONFIRMED','CHECKED_IN','COMPLETED','CANCELLED','REFUNDED','EXPIRED','NO_SHOW')),
  payment_status text NOT NULL DEFAULT 'UNPAID' CHECK (payment_status IN ('UNPAID','PENDING','WAITING_VERIFICATION','PAID','PARTIALLY_REFUNDED','REFUNDED')),
  total numeric(12,2) NOT NULL DEFAULT 0,
  language text NOT NULL DEFAULT 'th',
  access_token text NOT NULL UNIQUE,
  credential_id uuid,
  note text,
  checked_in_at timestamptz,
  checked_in_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookings_visit ON bookings (branch_id, visit_date);
CREATE INDEX bookings_phone ON bookings (phone);
CREATE INDEX bookings_email ON bookings (lower(email));
CREATE INDEX bookings_member ON bookings (member_id);
CREATE INDEX bookings_status ON bookings (status);

CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_no text NOT NULL UNIQUE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
  sale_item_id uuid REFERENCES sale_items(id) ON DELETE SET NULL,
  account_id uuid REFERENCES customer_accounts(id) ON DELETE SET NULL,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  package_id uuid NOT NULL REFERENCES packages(id),
  ticket_type_id uuid REFERENCES ticket_types(id),
  guest_name text,
  visit_date date NOT NULL,
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  days_allowed int NOT NULL DEFAULT 1,
  entries_per_day int,
  time_start time,
  time_end time,
  reentry boolean NOT NULL DEFAULT true,
  transferable boolean NOT NULL DEFAULT false,
  zone_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'UNPAID' CHECK (status IN ('UNPAID','PAID','ACTIVE','USED','EXPIRED','CANCELLED','REFUNDED')),
  presence text NOT NULL DEFAULT 'OUTSIDE' CHECK (presence IN ('OUTSIDE','ENTERING','INSIDE')),
  presence_gate_id uuid,
  presence_scan_id uuid,
  presence_since timestamptz,
  first_entry_at timestamptz,
  last_entry_at timestamptz,
  last_exit_at timestamptz,
  entry_count int NOT NULL DEFAULT 0,
  price numeric(12,2) NOT NULL DEFAULT 0,
  credential_id uuid,
  activated_at timestamptz,
  used_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to >= valid_from)
);
CREATE INDEX tickets_branch_visit ON tickets (branch_id, visit_date);
CREATE INDEX tickets_booking ON tickets (booking_id);
CREATE INDEX tickets_account ON tickets (account_id);
CREATE INDEX tickets_member ON tickets (member_id);
CREATE INDEX tickets_inside ON tickets (branch_id) WHERE presence <> 'OUTSIDE';
CREATE INDEX tickets_status ON tickets (status);

CREATE TABLE ticket_usage_days (
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  visit_date date NOT NULL,
  entries int NOT NULL DEFAULT 0,
  first_entry_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, visit_date)
);

CREATE TABLE booking_guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  ticket_type_id uuid REFERENCES ticket_types(id),
  name text,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  sort int NOT NULL DEFAULT 0
);
CREATE INDEX booking_guests_booking ON booking_guests (booking_id);

-- ---------------------------------------------------------------- credentials (cards / wristbands / QR tickets / booking barcodes)
CREATE TABLE wristband_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  type text NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  type text NOT NULL CHECK (type IN ('MEMBER_CARD','DIGITAL_CARD','TEMP_CARD','TEMP_WRISTBAND','PRINTED_WRISTBAND','QR_TICKET','BOOKING','RFID')),
  token_version int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','ACTIVE','SUSPENDED','LOST','BLOCKED','EXPIRED','REPLACED','CLOSED')),
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  account_id uuid REFERENCES customer_accounts(id) ON DELETE SET NULL,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  batch_id uuid REFERENCES wristband_batches(id) ON DELETE SET NULL,
  label text,
  height_cm int,
  expiry_policy text NOT NULL DEFAULT 'NONE' CHECK (expiry_policy IN ('NONE','END_OF_VISIT','END_OF_DAY','PACKAGE_EXPIRY','FIXED')),
  expires_at timestamptz,
  rfid_uid text UNIQUE,
  replaced_by uuid REFERENCES credentials(id) ON DELETE SET NULL,
  issued_by uuid REFERENCES users(id) ON DELETE SET NULL,
  issued_at timestamptz,
  activated_at timestamptz,
  status_reason text,
  last_zone_id uuid REFERENCES zones(id) ON DELETE SET NULL,
  last_seen_at timestamptz,
  print_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credentials_account ON credentials (account_id);
CREATE INDEX credentials_member ON credentials (member_id);
CREATE INDEX credentials_booking ON credentials (booking_id);
CREATE INDEX credentials_status ON credentials (type, status);

ALTER TABLE tickets ADD CONSTRAINT tickets_credential_fk FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD CONSTRAINT bookings_credential_fk FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE SET NULL;
ALTER TABLE sales ADD CONSTRAINT sales_credential_fk FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE SET NULL;
ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_credential_fk FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE SET NULL;
ALTER TABLE memberships ADD CONSTRAINT memberships_sale_fk FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL;
ALTER TABLE payment_verification_requests ADD CONSTRAINT pvr_booking_fk FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;

-- Explicit credential ↔ ticket bindings (wristband bound at the counter, ticket's own QR, re-issued cards).
CREATE TABLE credential_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  unlinked_at timestamptz
);
CREATE UNIQUE INDEX credential_links_active ON credential_links (credential_id, ticket_id) WHERE unlinked_at IS NULL;
CREATE INDEX credential_links_ticket ON credential_links (ticket_id) WHERE unlinked_at IS NULL;

CREATE TABLE membership_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  membership_id uuid REFERENCES memberships(id) ON DELETE SET NULL,
  credential_id uuid NOT NULL UNIQUE REFERENCES credentials(id) ON DELETE CASCADE,
  card_type text NOT NULL CHECK (card_type IN ('PHYSICAL','DIGITAL')),
  issued_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE card_replacements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  old_credential_id uuid NOT NULL REFERENCES credentials(id),
  new_credential_id uuid NOT NULL REFERENCES credentials(id),
  reason text NOT NULL CHECK (reason IN ('LOST','DAMAGED','STOLEN','UPGRADE','OTHER')),
  transferred jsonb NOT NULL DEFAULT '{}',
  note text,
  staff_id uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blacklist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid REFERENCES branches(id) ON DELETE CASCADE,
  credential_id uuid REFERENCES credentials(id) ON DELETE CASCADE,
  member_id uuid REFERENCES members(id) ON DELETE CASCADE,
  phone text,
  reason text NOT NULL,
  until timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (credential_id IS NOT NULL OR member_id IS NOT NULL OR phone IS NOT NULL)
);

-- ---------------------------------------------------------------- entitlements
CREATE TABLE ride_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES customer_accounts(id) ON DELETE CASCADE,
  ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE,
  credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  branch_id uuid REFERENCES branches(id) ON DELETE CASCADE,
  ride_id uuid REFERENCES rides(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('ONE_TIME','MULTI_USE','UNLIMITED','TIME_BASED','DATE_BASED')),
  uses_total int,
  uses_left int CHECK (uses_left IS NULL OR uses_left >= 0),
  valid_from timestamptz,
  valid_until timestamptz,
  is_fast_pass boolean NOT NULL DEFAULT false,
  source text NOT NULL CHECK (source IN ('PACKAGE','ADDON','REWARD','MEMBERSHIP','COMP','TRANSFER')),
  sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
  sale_item_id uuid REFERENCES sale_items(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXHAUSTED','EXPIRED','REVOKED','REFUNDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (account_id IS NOT NULL OR ticket_id IS NOT NULL OR credential_id IS NOT NULL)
);
CREATE INDEX ride_entitlements_ticket ON ride_entitlements (ticket_id) WHERE status = 'ACTIVE';
CREATE INDEX ride_entitlements_credential ON ride_entitlements (credential_id) WHERE status = 'ACTIVE';
CREATE INDEX ride_entitlements_account ON ride_entitlements (account_id) WHERE status = 'ACTIVE';
-- One add-on entitlement per paid sale line (retries / duplicate webhooks cannot double-issue).
CREATE UNIQUE INDEX ride_entitlements_sale_item ON ride_entitlements (sale_item_id, ride_id) WHERE sale_item_id IS NOT NULL AND source = 'ADDON';

CREATE TABLE ride_access_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  ride_id uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  scan_point_id uuid REFERENCES ride_scan_points(id) ON DELETE SET NULL,
  credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  entitlement_id uuid REFERENCES ride_entitlements(id) ON DELETE SET NULL,
  result text NOT NULL CHECK (result IN ('GRANTED','DENIED','NOT_INCLUDED','PAYMENT_PENDING','QUEUE_JOINED')),
  reason_code text,
  checks jsonb NOT NULL DEFAULT '[]',
  operator_id uuid REFERENCES users(id) ON DELETE SET NULL,
  manual boolean NOT NULL DEFAULT false,
  device_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ride_access_logs_ride ON ride_access_logs (ride_id, created_at DESC);
CREATE INDEX ride_access_logs_credential ON ride_access_logs (credential_id, created_at DESC);
CREATE INDEX ride_access_logs_member ON ride_access_logs (member_id, created_at DESC);

CREATE TABLE ride_entitlement_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id uuid NOT NULL REFERENCES ride_entitlements(id) ON DELETE CASCADE,
  ride_id uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  access_log_id uuid UNIQUE REFERENCES ride_access_logs(id) ON DELETE SET NULL,
  operator_id uuid REFERENCES users(id) ON DELETE SET NULL,
  uses_left_after int,
  used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ride_entitlement_usage_ent ON ride_entitlement_usage (entitlement_id);

CREATE TABLE ride_queues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  ride_id uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  service_date date NOT NULL,
  seq int NOT NULL,
  queue_no text NOT NULL,
  credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  account_id uuid REFERENCES customer_accounts(id) ON DELETE SET NULL,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  party_size int NOT NULL DEFAULT 1 CHECK (party_size BETWEEN 1 AND 20),
  priority int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','CALLED','BOARDED','EXPIRED','CANCELLED','NO_SHOW')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  called_at timestamptz,
  call_expires_at timestamptz,
  boarded_at timestamptz,
  ended_at timestamptz,
  UNIQUE (ride_id, service_date, seq)
);
CREATE UNIQUE INDEX ride_queues_one_active ON ride_queues (ride_id, credential_id) WHERE status IN ('WAITING','CALLED');
CREATE INDEX ride_queues_active ON ride_queues (ride_id, status, priority DESC, seq);

-- ---------------------------------------------------------------- gates
CREATE TABLE gates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  code text NOT NULL,
  number int NOT NULL,
  name jsonb NOT NULL DEFAULT '{}',
  direction text NOT NULL DEFAULT 'ENTRY' CHECK (direction IN ('ENTRY','EXIT','BOTH')),
  zone_id uuid REFERENCES zones(id) ON DELETE SET NULL,
  mode text NOT NULL DEFAULT 'AUTO' CHECK (mode IN ('AUTO','MANUAL')),
  controller_kind text NOT NULL DEFAULT 'TURNSTILE' CHECK (controller_kind IN ('TURNSTILE','FLAP_BARRIER','SWING_GATE','RELAY','GPIO','NETWORK')),
  driver text NOT NULL DEFAULT 'SIMULATOR' CHECK (driver IN ('SIMULATOR','HTTP','RELAY_HTTP','EDGE_AGENT')),
  controller_config jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'IDLE' CHECK (state IN ('IDLE','SCANNING','VALIDATING','WAITING_APPROVAL','APPROVED','OPENING','OPEN','CLOSING','DENIED','ERROR','OFFLINE','EMERGENCY')),
  state_since timestamptz NOT NULL DEFAULT now(),
  state_version int NOT NULL DEFAULT 0,
  current_scan_id uuid,
  operator_id uuid REFERENCES users(id) ON DELETE SET NULL,
  open_seconds int NOT NULL DEFAULT 6 CHECK (open_seconds BETWEEN 1 AND 120),
  last_error text,
  last_scan_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, code),
  UNIQUE (branch_id, number)
);

CREATE TABLE gate_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_id uuid NOT NULL REFERENCES gates(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('SCANNER','DISPLAY','CONTROLLER')),
  UNIQUE (gate_id, device_id, role)
);

CREATE TABLE gate_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_no bigserial UNIQUE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  gate_id uuid NOT NULL REFERENCES gates(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('ENTRY','EXIT')),
  code text,
  credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  result text NOT NULL CHECK (result IN ('GRANTED','DENIED','PENDING','APPROVED','OPERATOR_DENIED','TIMEOUT','OVERRIDE','ERROR')),
  reason_code text,
  checks jsonb NOT NULL DEFAULT '[]',
  customer jsonb NOT NULL DEFAULT '{}',
  mode text NOT NULL DEFAULT 'AUTO',
  source text NOT NULL DEFAULT 'CAMERA' CHECK (source IN ('CAMERA','USB','RFID','MANUAL','API')),
  device_id text,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX gate_scans_gate ON gate_scans (gate_id, created_at DESC);
CREATE INDEX gate_scans_branch ON gate_scans (branch_id, created_at DESC);
CREATE INDEX gate_scans_ticket ON gate_scans (ticket_id);
CREATE INDEX gate_scans_credential ON gate_scans (credential_id);
ALTER TABLE gates ADD CONSTRAINT gates_current_scan_fk FOREIGN KEY (current_scan_id) REFERENCES gate_scans(id) ON DELETE SET NULL;

CREATE TABLE entry_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  gate_id uuid REFERENCES gates(id) ON DELETE SET NULL,
  scan_id uuid REFERENCES gate_scans(id) ON DELETE SET NULL,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK (direction IN ('ENTRY','EXIT')),
  status text NOT NULL DEFAULT 'PENDING_PASSAGE' CHECK (status IN ('PENDING_PASSAGE','CONFIRMED','NO_PASSAGE','CANCELLED')),
  visit_date date NOT NULL,
  operator_id uuid REFERENCES users(id) ON DELETE SET NULL,
  device_id text,
  override boolean NOT NULL DEFAULT false,
  approved_at timestamptz NOT NULL DEFAULT now(),
  passed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX entry_logs_branch_date ON entry_logs (branch_id, visit_date, direction) WHERE status = 'CONFIRMED';
CREATE INDEX entry_logs_ticket ON entry_logs (ticket_id, created_at DESC);
CREATE UNIQUE INDEX entry_logs_one_pending_per_ticket ON entry_logs (ticket_id) WHERE status = 'PENDING_PASSAGE';

CREATE TABLE security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid REFERENCES branches(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('DUPLICATE_ENTRY','PASSBACK','BLACKLISTED','REVOKED_CREDENTIAL','FORGED_TOKEN','EXPIRED_QR','EMERGENCY','OBSTRUCTION','FIRE_ALARM','OVERRIDE','SUSPICIOUS_LOGIN','RAPID_SCANS')),
  severity text NOT NULL DEFAULT 'WARNING' CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  gate_id uuid REFERENCES gates(id) ON DELETE SET NULL,
  scan_id uuid REFERENCES gate_scans(id) ON DELETE SET NULL,
  credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  data jsonb NOT NULL DEFAULT '{}',
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_branch ON security_events (branch_id, created_at DESC);

-- ---------------------------------------------------------------- lockers
CREATE TABLE lockers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  zone_id uuid REFERENCES zones(id) ON DELETE SET NULL,
  bank text NOT NULL DEFAULT 'A',
  code text NOT NULL,
  size text NOT NULL DEFAULT 'M' CHECK (size IN ('S','M','L','XL')),
  status text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','OCCUPIED','OUT_OF_SERVICE')),
  driver text NOT NULL DEFAULT 'SIMULATOR' CHECK (driver IN ('SIMULATOR','HTTP','EDGE_AGENT')),
  controller_config jsonb NOT NULL DEFAULT '{}',
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, code)
);

CREATE TABLE locker_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid REFERENCES branches(id) ON DELETE CASCADE,
  size text CHECK (size IS NULL OR size IN ('S','M','L','XL')),
  label jsonb NOT NULL DEFAULT '{}',
  minutes int CHECK (minutes IS NULL OR minutes > 0),
  price numeric(12,2) NOT NULL CHECK (price >= 0),
  member_price numeric(12,2),
  sort int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE locker_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  locker_id uuid NOT NULL REFERENCES lockers(id) ON DELETE CASCADE,
  credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  account_id uuid REFERENCES customer_accounts(id) ON DELETE SET NULL,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
  sale_item_id uuid UNIQUE REFERENCES sale_items(id) ON DELETE SET NULL,
  rate_id uuid REFERENCES locker_rates(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED','EXPIRED','FORCE_OPENED')),
  start_at timestamptz NOT NULL DEFAULT now(),
  expire_at timestamptz NOT NULL,
  ended_at timestamptz,
  open_count int NOT NULL DEFAULT 0,
  last_opened_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX locker_sessions_one_active ON locker_sessions (locker_id) WHERE status = 'ACTIVE';
CREATE INDEX locker_sessions_credential ON locker_sessions (credential_id) WHERE status = 'ACTIVE';

CREATE TABLE locker_access_logs (
  id bigserial PRIMARY KEY,
  locker_id uuid NOT NULL REFERENCES lockers(id) ON DELETE CASCADE,
  session_id uuid REFERENCES locker_sessions(id) ON DELETE SET NULL,
  credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('OPEN','DENIED','FORCE_OPEN','RELEASE')),
  reason text,
  staff_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- inventory per store
CREATE TABLE inventory (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  qty numeric(12,2) NOT NULL DEFAULT 0,
  min_qty numeric(12,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, store_id)
);

CREATE TABLE inventory_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no text NOT NULL UNIQUE,
  from_store_id uuid NOT NULL REFERENCES stores(id),
  to_store_id uuid NOT NULL REFERENCES stores(id),
  items jsonb NOT NULL,
  note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_store_id <> to_store_id)
);

CREATE TABLE inventory_movements (
  id bigserial PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('IN','OUT','TRANSFER_IN','TRANSFER_OUT','ADJUST','WASTE','SALE','RETURN')),
  qty numeric(12,2) NOT NULL,
  qty_after numeric(12,2) NOT NULL,
  ref_type text,
  ref_id uuid,
  transfer_id uuid REFERENCES inventory_transfers(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_product ON inventory_movements (product_id, store_id, created_at DESC);
CREATE UNIQUE INDEX inventory_movements_sale_once ON inventory_movements (ref_id, product_id, store_id, type)
  WHERE ref_id IS NOT NULL AND type IN ('SALE','RETURN');

-- ---------------------------------------------------------------- promotions / coupons / rewards
ALTER TABLE promotions ADD COLUMN applies_to text NOT NULL DEFAULT 'FOOD' CHECK (applies_to IN ('FOOD','PARK','ALL'));
ALTER TABLE promotions ADD COLUMN channels text[] NOT NULL DEFAULT '{}';
ALTER TABLE promotions ADD COLUMN item_types text[] NOT NULL DEFAULT '{}';
ALTER TABLE promotions ADD COLUMN package_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE promotions ADD COLUMN ticket_type_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE promotions ADD COLUMN tier_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE promotions ADD COLUMN min_qty int;
ALTER TABLE promotions ADD COLUMN max_units int;
ALTER TABLE promotions ADD COLUMN advance_days int;
ALTER TABLE promotions ADD COLUMN birthday_only boolean NOT NULL DEFAULT false;
ALTER TABLE promotions ADD COLUMN members_only boolean NOT NULL DEFAULT false;
ALTER TABLE promotions ADD COLUMN stackable boolean NOT NULL DEFAULT true;
ALTER TABLE promotions ADD COLUMN usage_per_member int;
CREATE INDEX promotions_applies ON promotions (applies_to) WHERE is_active;

CREATE TABLE coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  promotion_id uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  member_id uuid REFERENCES members(id) ON DELETE CASCADE,
  max_uses int NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count int NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  valid_from date,
  valid_to date,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','USED','EXPIRED','VOID')),
  source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','REWARD','BIRTHDAY','BATCH','PACKAGE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (used_count <= max_uses)
);
CREATE UNIQUE INDEX coupons_code_unique ON coupons (upper(code));
CREATE INDEX coupons_member ON coupons (member_id) WHERE status = 'ACTIVE';

CREATE TABLE promotion_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  coupon_id uuid REFERENCES coupons(id) ON DELETE SET NULL,
  member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  sale_id uuid REFERENCES sales(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promotion_id, sale_id)
);
CREATE INDEX promotion_redemptions_member ON promotion_redemptions (promotion_id, member_id);

CREATE TABLE rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name jsonb NOT NULL DEFAULT '{}',
  description jsonb NOT NULL DEFAULT '{}',
  image_url text,
  reward_type text NOT NULL CHECK (reward_type IN ('COUPON','TICKET','RIDE','FOOD','DRINK','SOUVENIR','LOCKER','UPGRADE','WALLET_CREDIT')),
  points_required int NOT NULL CHECK (points_required > 0),
  stock int CHECK (stock IS NULL OR stock >= 0),
  start_at timestamptz,
  end_at timestamptz,
  tier_ids uuid[] NOT NULL DEFAULT '{}',
  ref_id uuid,
  value numeric(12,2) NOT NULL DEFAULT 0,
  valid_days int NOT NULL DEFAULT 30,
  per_member_limit int,
  sort int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reward_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  redemption_no text NOT NULL UNIQUE,
  reward_id uuid NOT NULL REFERENCES rewards(id),
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  points int NOT NULL,
  status text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','USED','EXPIRED','CANCELLED')),
  coupon_id uuid REFERENCES coupons(id) ON DELETE SET NULL,
  entitlement_id uuid REFERENCES ride_entitlements(id) ON DELETE SET NULL,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  voucher_code text,
  expires_at timestamptz,
  used_at timestamptz,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reward_redemptions_member ON reward_redemptions (member_id, created_at DESC);

-- ---------------------------------------------------------------- shifts & cash
CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_no text NOT NULL UNIQUE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  user_id uuid NOT NULL REFERENCES users(id),
  terminal text NOT NULL DEFAULT 'COUNTER' CHECK (terminal IN ('COUNTER','POS','KIOSK','RIDE','LOCKER')),
  store_id uuid REFERENCES stores(id) ON DELETE SET NULL,
  device_id text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  opening_cash numeric(12,2) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  closed_at timestamptz,
  actual_cash numeric(12,2),
  expected_cash numeric(12,2),
  over_short numeric(12,2),
  totals jsonb NOT NULL DEFAULT '{}',
  note text,
  closed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX shifts_one_open_per_user ON shifts (user_id) WHERE status = 'OPEN';

CREATE TABLE cash_movements (
  id bigserial PRIMARY KEY,
  shift_id uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('CASH_SALE','CASH_TOPUP','CASH_REFUND','CASH_OUT','CASH_IN','CASH_ORDER')),
  amount numeric(12,2) NOT NULL,
  ref_type text,
  ref_id uuid,
  note text,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cash_movements_shift ON cash_movements (shift_id);
CREATE UNIQUE INDEX cash_movements_ref_once ON cash_movements (ref_id, type) WHERE ref_id IS NOT NULL AND type IN ('CASH_SALE','CASH_TOPUP','CASH_REFUND','CASH_ORDER');

ALTER TABLE sales ADD CONSTRAINT sales_shift_fk FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL;
ALTER TABLE sale_payments ADD CONSTRAINT sale_payments_shift_fk FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- approvals, notifications
CREATE TABLE manager_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  action text NOT NULL,
  staff_id uuid REFERENCES users(id) ON DELETE SET NULL,
  manager_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text,
  reference text,
  entity text,
  entity_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX manager_approvals_created ON manager_approvals (created_at DESC);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid REFERENCES branches(id) ON DELETE CASCADE,
  audience text NOT NULL DEFAULT 'STAFF' CHECK (audience IN ('STAFF','ACCOUNT')),
  account_id uuid REFERENCES customer_accounts(id) ON DELETE CASCADE,
  type text NOT NULL,
  severity text NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  title jsonb NOT NULL DEFAULT '{}',
  body jsonb NOT NULL DEFAULT '{}',
  data jsonb NOT NULL DEFAULT '{}',
  dedupe_key text UNIQUE,
  read_at timestamptz,
  read_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_staff ON notifications (branch_id, created_at DESC) WHERE audience = 'STAFF';
CREATE INDEX notifications_account ON notifications (account_id, created_at DESC) WHERE audience = 'ACCOUNT';

-- ---------------------------------------------------------------- restaurant module ↔ park credential
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('QR','CASH','CARD','OTHER','WALLET'));
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_source_check CHECK (source IN ('KIOSK','CASHIER','MOBILE','POS'));
ALTER TABLE orders ADD COLUMN account_id uuid REFERENCES customer_accounts(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN member_id uuid REFERENCES members(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN store_id uuid REFERENCES stores(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN points_earned int NOT NULL DEFAULT 0;
CREATE INDEX orders_account ON orders (account_id);
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('QR','CASH','CARD','OTHER','WALLET'));
ALTER TABLE payments ADD COLUMN wallet_ledger_id uuid REFERENCES wallet_ledger(id);

-- Printing: generic pre-rendered documents (park receipts, tickets, wristbands, shift reports).
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_document_type_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_document_type_check CHECK (document_type IN ('RECEIPT','KITCHEN_TICKET','TEST','DOC'));
ALTER TABLE print_jobs ADD COLUMN sale_id uuid REFERENCES sales(id) ON DELETE CASCADE;
CREATE INDEX print_jobs_sale ON print_jobs (sale_id);
ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_type_check;
ALTER TABLE printers ADD CONSTRAINT printers_type_check CHECK (type IN ('RECEIPT','KITCHEN','BEVERAGE','DESSERT','OTHER','TICKET','WRISTBAND','LABEL'));
ALTER TABLE printers ADD CONSTRAINT printers_driver_check CHECK (driver IN ('ESCPOS','ZPL'));
ALTER TABLE printers ADD COLUMN store_id uuid REFERENCES stores(id) ON DELETE SET NULL;

ALTER TABLE audit_logs ADD COLUMN reason text;

-- ---------------------------------------------------------------- spec-named views over the unified tables
CREATE VIEW booking_items AS
  SELECT si.*, b.id AS booking_id FROM sale_items si JOIN bookings b ON b.sale_id = si.sale_id;
CREATE VIEW booking_payments AS
  SELECT sp.*, b.id AS booking_id FROM sale_payments sp JOIN bookings b ON b.sale_id = sp.sale_id;
CREATE VIEW wristbands AS
  SELECT c.* FROM credentials c WHERE c.type IN ('TEMP_WRISTBAND','PRINTED_WRISTBAND');
CREATE VIEW wallets AS SELECT * FROM wallet_accounts;
CREATE VIEW wallet_transactions AS SELECT * FROM wallet_ledger;
CREATE VIEW ride_queue_entries AS SELECT * FROM ride_queues;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zones','devices','stores','member_tiers','membership_products','members','memberships','wallet_accounts',
    'ticket_types','packages','rides','ride_scan_points','sales','sale_payments','bookings','tickets','credentials','ride_entitlements',
    'gates','lockers','rewards'] LOOP
    EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t, t);
  END LOOP;
END $$;
