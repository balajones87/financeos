-- FinanceOS — RESET COMPLETO
-- Apaga tabelas existentes e recria tudo do zero
-- Execute no SQL Editor do Supabase

-- 1. Remove triggers
drop trigger if exists on_auth_user_created on auth.users;

-- 2. Remove funções
drop function if exists handle_new_user();
drop function if exists seed_categories_for_user(uuid);
drop function if exists auto_categorize_transaction(uuid);

-- 3. Remove views
drop view if exists monthly_summary;

-- 4. Remove tabelas (ordem inversa de dependência)
drop table if exists sync_logs              cascade;
drop table if exists investimentos_cripto   cascade;
drop table if exists investimentos_acoes    cascade;
drop table if exists investimentos_rf       cascade;
drop table if exists consorcios             cascade;
drop table if exists imoveis               cascade;
drop table if exists recorrentes            cascade;
drop table if exists transactions           cascade;
drop table if exists categorization_rules   cascade;
drop table if exists budgets               cascade;
drop table if exists categories             cascade;
drop table if exists accounts              cascade;

-- 5. Extensão
create extension if not exists "uuid-ossp";

-- ============================================================
-- RECRIA TUDO
-- ============================================================

create table accounts (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid references auth.users not null,
  local_id          text not null,
  name              text not null,
  type              text not null,
  bank              text,
  color             text default '#4d9fff',
  icon              text default '🏦',
  pluggy_item_id    text,
  pluggy_account_id text,
  balance           numeric(15,2) default 0,
  is_active         boolean default true,
  last_sync         timestamptz,
  created_at        timestamptz default now()
);
create index idx_acc_user on accounts(user_id);

create table categories (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid references auth.users not null,
  name       text not null,
  icon       text default '📦',
  color      text default '#888',
  type       text default 'expense',
  is_system  boolean default false,
  created_at timestamptz default now()
);

create table categorization_rules (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references auth.users not null,
  keyword     text not null,
  category_id uuid references categories,
  account_id  uuid references accounts,
  match_type  text default 'contains',
  priority    int default 0,
  apply_count int default 0,
  is_active   boolean default true,
  source      text default 'user',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index idx_rules_user    on categorization_rules(user_id);
create index idx_rules_keyword on categorization_rules(keyword);

create table transactions (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid references auth.users not null,
  account_id          uuid references accounts not null,
  category_id         uuid references categories,
  description         text not null,
  amount              numeric(15,2) not null,
  tx_date             date not null,
  tx_type             text not null,
  is_card_tx          boolean default false,
  card_invoice_month  text,
  installment_current int,
  installment_total   int,
  cat_origin          text default 'pending',
  cat_rule_id         uuid references categorization_rules,
  external_id         text unique,
  raw_description     text,
  raw_data            jsonb,
  notes               text,
  tags                text[],
  is_reconciled       boolean default false,
  is_hidden           boolean default false,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);
create index idx_tx_user    on transactions(user_id);
create index idx_tx_account on transactions(account_id);
create index idx_tx_date    on transactions(tx_date desc);
create index idx_tx_pending on transactions(user_id) where cat_origin = 'pending';

create table imoveis (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid references auth.users not null,
  nome         text not null,
  tipo         text not null,
  endereco     text,
  compra_ano   int,
  valor_compra numeric(15,2) not null,
  valor_atual  numeric(15,2) not null,
  aluguel      numeric(15,2) default 0,
  inquilino    text,
  account_id   uuid references accounts,
  notas        text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
create index idx_imoveis_user on imoveis(user_id);

create table consorcios (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid references auth.users not null,
  nome           text not null,
  tipo           text default 'Imovel',
  valor_carta    numeric(15,2) not null,
  parcela        numeric(15,2) not null,
  total_parcelas int not null,
  parcelas_pagas int default 0,
  status         text default 'ativo',
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
create index idx_cons_user on consorcios(user_id);

create table investimentos_rf (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid references auth.users not null,
  nome       text not null,
  investido  numeric(15,2) not null,
  atual      numeric(15,2) not null,
  vencimento text,
  rentab_pct numeric(8,4),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_rf_user on investimentos_rf(user_id);

create table investimentos_acoes (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid references auth.users not null,
  ticker     text not null,
  nome       text,
  tipo       text default 'Acao',
  qtd        numeric(15,6) not null,
  p_medio    numeric(15,4) not null,
  p_atual    numeric(15,4) not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_acoes_user on investimentos_acoes(user_id);

create table investimentos_cripto (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid references auth.users not null,
  ticker          text not null,
  nome            text,
  qtd             numeric(20,8) not null,
  custo_medio_brl numeric(15,4) not null,
  preco_atual_brl numeric(15,4) not null,
  total_investido numeric(15,2) not null,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create index idx_cripto_user on investimentos_cripto(user_id);

create table recorrentes (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid references auth.users not null,
  name         text not null,
  amount       numeric(15,2) not null,
  day_of_month int not null,
  type         text not null,
  account_id   uuid references accounts,
  category_id  uuid references categories,
  keyword      text,
  is_pj        boolean default false,
  empresa      text,
  is_active    boolean default true,
  created_at   timestamptz default now()
);
create index idx_rec_user on recorrentes(user_id);

create table sync_logs (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid references auth.users not null,
  account_id     uuid references accounts,
  status         text not null,
  tx_imported    int default 0,
  tx_duplicates  int default 0,
  tx_categorized int default 0,
  error_msg      text,
  started_at     timestamptz default now(),
  finished_at    timestamptz
);

-- RLS
alter table accounts              enable row level security;
alter table categories            enable row level security;
alter table categorization_rules  enable row level security;
alter table transactions          enable row level security;
alter table imoveis               enable row level security;
alter table consorcios            enable row level security;
alter table investimentos_rf      enable row level security;
alter table investimentos_acoes   enable row level security;
alter table investimentos_cripto  enable row level security;
alter table recorrentes           enable row level security;
alter table sync_logs             enable row level security;

create policy "own" on accounts             for all using (auth.uid() = user_id);
create policy "own" on categories           for all using (auth.uid() = user_id);
create policy "own" on categorization_rules for all using (auth.uid() = user_id);
create policy "own" on transactions         for all using (auth.uid() = user_id);
create policy "own" on imoveis              for all using (auth.uid() = user_id);
create policy "own" on consorcios           for all using (auth.uid() = user_id);
create policy "own" on investimentos_rf     for all using (auth.uid() = user_id);
create policy "own" on investimentos_acoes  for all using (auth.uid() = user_id);
create policy "own" on investimentos_cripto for all using (auth.uid() = user_id);
create policy "own" on recorrentes          for all using (auth.uid() = user_id);
create policy "own" on sync_logs            for all using (auth.uid() = user_id);

-- Seed categorias para novo usuario
create or replace function seed_categories_for_user(p_user_id uuid)
returns void as $$
begin
  insert into categories (user_id, name, icon, color, type, is_system) values
    (p_user_id, 'Alimentacao',    '🍔', '#ffb020', 'expense', true),
    (p_user_id, 'Saude',          '🏥', '#00d4aa', 'expense', true),
    (p_user_id, 'Moradia',        '🏠', '#4d9fff', 'expense', true),
    (p_user_id, 'Transporte',     '🚗', '#9d7fff', 'expense', true),
    (p_user_id, 'Lazer',          '🎮', '#ff6464', 'expense', true),
    (p_user_id, 'Educacao',       '📚', '#64c864', 'expense', true),
    (p_user_id, 'Servicos',       '⚙', '#9696c8', 'expense', true),
    (p_user_id, 'Investimento',   '📈', '#ffc832', 'expense', true),
    (p_user_id, 'Outros',         '📦', '#888888', 'expense', true),
    (p_user_id, 'Renda',          '💰', '#00d4aa', 'income',  true),
    (p_user_id, 'Receita Energia','⚡', '#f59e0b', 'income',  true),
    (p_user_id, 'Manutencao',     '🔧', '#ff4d6d', 'expense', true),
    (p_user_id, 'Contabilidade',  '📑', '#ff8c42', 'expense', true);
end;
$$ language plpgsql security definer;

-- Trigger: seed ao criar usuario
create or replace function handle_new_user()
returns trigger as $$
begin
  perform seed_categories_for_user(new.id);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- Auto-categorizar pelo banco
create or replace function auto_categorize_transaction(p_tx_id uuid)
returns void as $$
declare
  v_tx      transactions%rowtype;
  v_rule    categorization_rules%rowtype;
  v_desc_up text;
begin
  select * into v_tx from transactions where id = p_tx_id;
  v_desc_up := upper(v_tx.description);
  select r.* into v_rule
  from categorization_rules r
  where r.user_id   = v_tx.user_id
    and r.is_active = true
    and (r.account_id is null or r.account_id = v_tx.account_id)
    and (
      (r.match_type = 'contains'    and v_desc_up like '%' || upper(r.keyword) || '%')
      or (r.match_type = 'starts_with' and v_desc_up like upper(r.keyword) || '%')
      or (r.match_type = 'exact'       and v_desc_up = upper(r.keyword))
    )
  order by r.priority desc, r.apply_count desc limit 1;
  if found then
    update transactions
    set category_id = v_rule.category_id,
        cat_origin  = 'rule',
        cat_rule_id = v_rule.id,
        updated_at  = now()
    where id = p_tx_id;
    update categorization_rules
    set apply_count = apply_count + 1, updated_at = now()
    where id = v_rule.id;
  end if;
end;
$$ language plpgsql security definer;

-- View resumo mensal
create or replace view monthly_summary as
select
  t.user_id,
  to_char(t.tx_date, 'YYYY-MM') as month,
  c.name as category,
  c.icon as icon,
  sum(case when t.amount < 0 then abs(t.amount) else 0 end) as total_expenses,
  sum(case when t.amount > 0 then t.amount else 0 end) as total_income,
  count(*) as tx_count
from transactions t
left join categories c on c.id = t.category_id
where t.is_hidden = false
  and t.tx_type != 'transfer_internal'
group by t.user_id, month, c.name, c.icon;
