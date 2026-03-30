/**
 * FinanceOS — Supabase Client + Persistência
 * supabase-client.js
 *
 * Inclua no index.html ANTES de pluggy-sync.js:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="supabase-client.js"></script>
 *
 * Configure as variáveis abaixo com os valores do seu projeto Supabase:
 *   Painel Supabase → Settings → API
 */

// ─── Configuração (preencher após criar o projeto) ────────────
const SUPABASE_URL  = 'https://weywcaooqwmppoglmazf.supabase.co';
const SUPABASE_ANON = 'sb_publishable_8vZzoOg0jMrDtQKugF7ZmQ_SPQL1lCW';

// ─── Inicialização ────────────────────────────────────────────
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON);

// ─── Auth state ───────────────────────────────────────────────
let currentUser = null;

async function initAuth() {
  const { data: { session } } = await db.auth.getSession();
  if (session?.user) {
    currentUser = session.user;
    console.log('[Supabase] Sessão ativa:', currentUser.email);
    await loadAllData();
  } else {
    showLoginScreen();
  }

  db.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN') {
      currentUser = session.user;
      await loadAllData();
      hideLoginScreen();
    } else if (event === 'SIGNED_OUT') {
      currentUser = null;
      showLoginScreen();
    }
  });
}

// ─── Login / Logout ───────────────────────────────────────────
async function loginWithEmail(email, password) {
  const { data, error } = await db.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function signUpWithEmail(email, password) {
  const { data, error } = await db.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

async function logout() {
  await db.auth.signOut();
}

// ─── Carregar todos os dados do banco → variáveis globais ─────
async function loadAllData() {
  if (!currentUser) return;
  console.log('[Supabase] Carregando dados...');

  try {
    // 1. Salva as contas locais no Supabase (upsert — não duplica)
    await saveAllAccounts();

    // 2. Carrega tudo do banco
    await Promise.all([
      loadCategories(),
      loadTransactions(),
      loadRules(),
      loadImoveis(),
      loadConsorcios(),
      loadInvestimentos(),
      loadRecorrentes(),
    ]);
    console.log('[Supabase] Dados carregados com sucesso');

    // 3. Atualiza a UI
    if (window.renderDashboard)     window.renderDashboard();
    if (window.renderDashboardTx)  window.renderDashboardTx();
    if (window.renderCatBars)      window.renderCatBars();
    if (window.updatePendingBadge) window.updatePendingBadge();
    if (window.renderTransactions) window.renderTransactions();

  } catch (err) {
    console.error('[Supabase] Erro ao carregar dados:', err);
  }
}

// ─── CONTAS ───────────────────────────────────────────────────
async function loadAccounts() {
  const { data, error } = await db.from('accounts').select('*').eq('user_id', currentUser.id);
  if (error) throw error;
  window._DB_ACCOUNTS = data || [];
  if (data?.length > 0) {
    const mapped = data.map(a => ({
      id:      a.local_id,
      _db_id:  a.id,
      name:    a.name,
      type:    a.type,
      color:   a.color,
      icon:    a.icon,
      balance: parseFloat(a.balance) || 0,
      pluggy_item_id:    a.pluggy_item_id,
      pluggy_account_id: a.pluggy_account_id,
      last_sync: a.last_sync,
    }));
    if (window.ACCOUNTS) {
      window.ACCOUNTS.length = 0;
      window.ACCOUNTS.push(...mapped);
    } else {
      window.ACCOUNTS = mapped;
    }
  }
}

async function saveAccount(acc) {
  const { data, error } = await db.from('accounts').upsert({
    user_id:           currentUser.id,
    local_id:          acc.id,
    name:              acc.name,
    type:              acc.type || 'checking',
    color:             acc.color,
    icon:              acc.icon,
    balance:           acc.balance,
    pluggy_item_id:    acc.pluggy_item_id || null,
    pluggy_account_id: acc.pluggy_account_id || null,
    last_sync:         acc.last_sync || null,
  }, { onConflict: 'user_id,local_id' }).select().single();
  if (error) throw error;
  return data;
}

async function saveAllAccounts() {
  if (!currentUser || !window.ACCOUNTS) return;
  for (const acc of window.ACCOUNTS) {
    await saveAccount(acc).catch(e => console.warn('Erro ao salvar conta:', e));
  }
  // Recarrega para ter os IDs do banco
  await loadAccounts();
}

// ─── CATEGORIAS ───────────────────────────────────────────────
async function loadCategories() {
  const { data, error } = await db.from('categories').select('*').eq('user_id', currentUser.id);
  if (error) throw error;
  if (data?.length > 0) {
    // Atualiza nomes nas categorias do app (mantém icones do app)
    // As categorias do banco são usadas para relacionamento com transações
    window._DB_CATEGORIES = data;
  }
}

async function getCategoryDbId(name) {
  if (!window._DB_CATEGORIES) return null;
  return window._DB_CATEGORIES.find(c => c.name === name)?.id || null;
}

async function getAccountDbId(localId) {
  if (!currentUser) return null;
  // Primeiro tenta no cache local
  if (window._DB_ACCOUNTS?.length > 0) {
    const cached = window._DB_ACCOUNTS.find(a => a.local_id === localId);
    if (cached) return cached.id;
  }
  // Busca no banco — usa maybeSingle para não lançar erro se não encontrar
  const { data } = await db.from('accounts')
    .select('id').eq('user_id', currentUser.id).eq('local_id', localId).maybeSingle();
  return data?.id || null;
}

// ─── TRANSAÇÕES ───────────────────────────────────────────────
async function loadTransactions(limit = 500) {
  const { data, error } = await db.from('transactions')
    .select('*, categories(name, icon), accounts(local_id, name)')
    .eq('user_id', currentUser.id)
    .order('tx_date', { ascending: false })
    .limit(limit);
  if (error) throw error;

  const mapped = (data || []).map(t => ({
    id:          t.id,
    date:        t.tx_date,
    desc:        t.description,
    amount:      parseFloat(t.amount),
    account:     t.accounts?.local_id || '',
    category:    t.categories?.name || null,
    txType:      t.tx_type,
    origin:      t.cat_origin,
    cardTx:      t.is_card_tx,
    external_id: t.external_id,
    notes:       t.notes,
  }));

  // MUTATE o array em vez de substituir — mantém a referência que renderTransactions usa
  if (window.TRANSACTIONS) {
    window.TRANSACTIONS.length = 0;
    window.TRANSACTIONS.push(...mapped);
  } else {
    window.TRANSACTIONS = mapped;
  }
  console.log(`[Supabase] ${mapped.length} transações carregadas`);
}

async function saveTransaction(tx) {
  if (!currentUser) return;
  
  // Garante que a conta existe no banco
  let accDbId = await getAccountDbId(tx.account);
  if (!accDbId) {
    // Tenta salvar a conta primeiro
    const localAcc = window.ACCOUNTS?.find(a => a.id === tx.account);
    if (localAcc) {
      const saved = await saveAccount(localAcc).catch(() => null);
      if (saved) {
        if (!window._DB_ACCOUNTS) window._DB_ACCOUNTS = [];
        window._DB_ACCOUNTS.push(saved);
        accDbId = saved.id;
      }
    }
  }
  if (!accDbId) {
    console.warn('[Supabase] Conta não encontrada para:', tx.account);
    return;
  }

  const externalId = tx.external_id || null;

  // Se não tem external_id, usa insert simples
  if (!externalId) {
    const { error } = await db.from('transactions').insert({
      user_id:     currentUser.id,
      account_id:  accDbId,
      category_id: catId,
      description: tx.desc,
      amount:      tx.amount,
      tx_date:     tx.date,
      tx_type:     tx.txType || (tx.amount > 0 ? 'credit' : 'debit'),
      is_card_tx:  tx.cardTx || false,
      cat_origin:  tx.origin || 'pending',
      updated_at:  new Date().toISOString(),
    });
    if (error) console.warn('[Supabase] Erro insert tx:', error.message);
    return;
  }

  // Com external_id: upsert com deduplicação
  const { error } = await db.from('transactions').upsert({
    user_id:     currentUser.id,
    account_id:  accDbId,
    category_id: catId,
    description: tx.desc,
    amount:      tx.amount,
    tx_date:     tx.date,
    tx_type:     tx.txType || (tx.amount > 0 ? 'credit' : 'debit'),
    is_card_tx:  tx.cardTx || false,
    cat_origin:  tx.origin || 'pending',
    external_id: externalId,
    raw_data:    tx.raw_data || null,
    updated_at:  new Date().toISOString(),
  }, { onConflict: 'external_id' });

  if (error) console.warn('[Supabase] Erro upsert tx:', error.message);
}

async function saveBatchTransactions(txs) {
  if (!currentUser || !txs?.length) return 0;
  let saved = 0;
  // Batch em grupos de 50
  for (let i = 0; i < txs.length; i += 50) {
    const batch = txs.slice(i, i + 50);
    await Promise.allSettled(batch.map(tx => saveTransaction(tx)));
    saved += batch.length;
  }
  return saved;
}

async function updateTransactionCategory(txId, categoryName, origin = 'manual') {
  if (!currentUser) return;
  const catId = await getCategoryDbId(categoryName);
  const { error } = await db.from('transactions').update({
    category_id: catId,
    cat_origin:  origin,
    updated_at:  new Date().toISOString(),
  }).eq('id', txId).eq('user_id', currentUser.id);
  if (error) throw error;
}

// ─── REGRAS ───────────────────────────────────────────────────
async function loadRules() {
  const { data, error } = await db.from('categorization_rules')
    .select('*, categories(name)').eq('user_id', currentUser.id).eq('is_active', true)
    .order('priority', { ascending: false });
  if (error) throw error;
  if (data?.length > 0) {
    window.RULES = data.map(r => ({
      id:       r.id,
      keyword:  r.keyword,
      category: r.categories?.name || null,
      account:  null,
      count:    r.apply_count,
    }));
  }
}

async function saveRule(rule) {
  if (!currentUser) return;
  const catId = await getCategoryDbId(rule.category);
  const { data, error } = await db.from('categorization_rules').upsert({
    id:          rule.id || undefined,
    user_id:     currentUser.id,
    keyword:     rule.keyword,
    category_id: catId,
    match_type:  'contains',
    apply_count: rule.count || 0,
    is_active:   true,
    source:      rule.source || 'user',
    updated_at:  new Date().toISOString(),
  }).select().single();
  if (error) throw error;
  return data;
}

async function deleteRule(ruleId) {
  if (!currentUser) return;
  await db.from('categorization_rules').update({ is_active: false }).eq('id', ruleId);
}

async function saveAllRules() {
  if (!currentUser || !window.RULES) return;
  for (const rule of window.RULES) {
    await saveRule(rule).catch(e => console.warn('Erro ao salvar regra:', e));
  }
}

// ─── IMÓVEIS ─────────────────────────────────────────────────
async function loadImoveis() {
  const { data, error } = await db.from('imoveis').select('*').eq('user_id', currentUser.id);
  if (error) throw error;
  if (data?.length > 0) {
    window.IMOVEIS = data.map(i => ({
      id:           i.id,
      nome:         i.nome,
      tipo:         i.tipo,
      endereco:     i.endereco,
      compraAno:    i.compra_ano,
      valorCompra:  parseFloat(i.valor_compra),
      valorAtual:   parseFloat(i.valor_atual),
      aluguel:      parseFloat(i.aluguel) || 0,
      inquilino:    i.inquilino,
      conta:        'itau',
    }));
  }
}

async function saveImovel(im) {
  if (!currentUser) return;
  const { error } = await db.from('imoveis').upsert({
    id:           im.id || undefined,
    user_id:      currentUser.id,
    nome:         im.nome,
    tipo:         im.tipo,
    endereco:     im.endereco,
    compra_ano:   im.compraAno,
    valor_compra: im.valorCompra,
    valor_atual:  im.valorAtual,
    aluguel:      im.aluguel || 0,
    inquilino:    im.inquilino,
    updated_at:   new Date().toISOString(),
  });
  if (error) throw error;
}

// ─── CONSÓRCIOS ───────────────────────────────────────────────
async function loadConsorcios() {
  const { data, error } = await db.from('consorcios').select('*').eq('user_id', currentUser.id);
  if (error) throw error;
  if (data?.length > 0) {
    window.CONSORCIOS = data.map(c => ({
      id:            c.id,
      nome:          c.nome,
      tipo:          c.tipo,
      valorCarta:    parseFloat(c.valor_carta),
      parcela:       parseFloat(c.parcela),
      totalParcelas: c.total_parcelas,
      parcelasPagas: c.parcelas_pagas,
    }));
  }
}

async function saveConsorcio(cons) {
  if (!currentUser) return;
  const { error } = await db.from('consorcios').upsert({
    id:             cons.id || undefined,
    user_id:        currentUser.id,
    nome:           cons.nome,
    tipo:           cons.tipo,
    valor_carta:    cons.valorCarta,
    parcela:        cons.parcela,
    total_parcelas: cons.totalParcelas,
    parcelas_pagas: cons.parcelasPagas,
    updated_at:     new Date().toISOString(),
  });
  if (error) throw error;
}

// ─── INVESTIMENTOS ────────────────────────────────────────────
async function loadInvestimentos() {
  const [rf, acoes, cripto] = await Promise.all([
    db.from('investimentos_rf').select('*').eq('user_id', currentUser.id),
    db.from('investimentos_acoes').select('*').eq('user_id', currentUser.id),
    db.from('investimentos_cripto').select('*').eq('user_id', currentUser.id),
  ]);

  if (rf.data?.length > 0) {
    window.RENDA_FIXA = rf.data.map(r => ({
      nome: r.nome, investido: parseFloat(r.investido), atual: parseFloat(r.atual),
      venc: r.vencimento, rentab: parseFloat(r.rentab_pct) || 0,
    }));
  }
  if (acoes.data?.length > 0) {
    window.ACOES_FIIS = acoes.data.map(a => ({
      ticker: a.ticker, nome: a.nome, tipo: a.tipo,
      qtd: parseFloat(a.qtd), pMedio: parseFloat(a.p_medio), atual: parseFloat(a.p_atual),
    }));
  }
  if (cripto.data?.length > 0) {
    window.CRIPTO = cripto.data.map(c => ({
      ticker: c.ticker, nome: c.nome, qtd: parseFloat(c.qtd),
      custoMedio: parseFloat(c.custo_medio_brl), atualBRL: parseFloat(c.preco_atual_brl),
      totalInvestido: parseFloat(c.total_investido),
    }));
  }
}

// ─── RECORRENTES ─────────────────────────────────────────────
async function loadRecorrentes() {
  const { data, error } = await db.from('recorrentes')
    .select('*, categories(name)').eq('user_id', currentUser.id).eq('is_active', true);
  if (error) throw error;
  if (data?.length > 0) {
    window.RECORRENTES = data.map(r => ({
      id:       r.id,
      name:     r.name,
      amount:   parseFloat(r.amount),
      day:      r.day_of_month,
      type:     r.type,
      account:  r.account_id,
      category: r.categories?.name || null,
      keyword:  r.keyword,
      active:   r.is_active,
      pj:       r.is_pj,
      empresa:  r.empresa,
    }));
  }
}

async function saveRecorrente(rec) {
  if (!currentUser) return;
  const catId = await getCategoryDbId(rec.category);
  const accDbId = rec.account ? await getAccountDbId(rec.account) : null;
  const { error } = await db.from('recorrentes').upsert({
    id:           rec.id || undefined,
    user_id:      currentUser.id,
    name:         rec.name,
    amount:       rec.amount,
    day_of_month: rec.day,
    type:         rec.type,
    account_id:   accDbId,
    category_id:  catId,
    keyword:      rec.keyword || null,
    is_pj:        rec.pj || false,
    empresa:      rec.empresa || null,
    is_active:    rec.active !== false,
  });
  if (error) throw error;
}

// ─── LOG SYNC ─────────────────────────────────────────────────
async function logSync(status, txImported, txDuplicates, txCategorized, errorMsg = null) {
  if (!currentUser) return;
  await db.from('sync_logs').insert({
    user_id:        currentUser.id,
    status,
    tx_imported:    txImported,
    tx_duplicates:  txDuplicates,
    tx_categorized: txCategorized,
    error_msg:      errorMsg,
    finished_at:    new Date().toISOString(),
  });
}

// ─── SAVE TUDO (chamado ao categorizar, criar regra, etc) ─────
async function persistChange(type, data) {
  if (!currentUser) return; // sem user, não persiste (modo demo)
  try {
    switch(type) {
      case 'transaction_category':
        await updateTransactionCategory(data.txId, data.category, data.origin);
        break;
      case 'rule':
        await saveRule(data);
        break;
      case 'rule_delete':
        await deleteRule(data.id);
        break;
      case 'recorrente':
        await saveRecorrente(data);
        break;
      case 'imovel':
        await saveImovel(data);
        break;
      case 'accounts':
        await saveAllAccounts();
        break;
    }
  } catch (err) {
    console.error('[Supabase] Erro ao persistir:', type, err);
  }
}

// ─── UI de Login ─────────────────────────────────────────────
function showLoginScreen() {
  let el = document.getElementById('login-screen');
  if (!el) {
    el = document.createElement('div');
    el.id = 'login-screen';
    el.style.cssText = `
      position:fixed;inset:0;background:var(--bg);z-index:1000;
      display:flex;align-items:center;justify-content:center;
    `;
    el.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border2);border-radius:14px;padding:36px 40px;width:360px">
        <div style="font-family:var(--mono);font-size:22px;color:var(--green);font-weight:600;margin-bottom:4px">FinanceOS</div>
        <div style="font-size:12px;color:var(--text3);margin-bottom:28px;letter-spacing:1px;text-transform:uppercase">Sistema Financeiro Pessoal</div>
        <div id="login-error" style="display:none;background:var(--red-dim);color:var(--red);padding:8px 12px;border-radius:6px;font-size:12px;margin-bottom:14px"></div>
        <div style="margin-bottom:12px">
          <label style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:6px">Email</label>
          <input id="login-email" type="email" style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;color:var(--text);font-family:var(--sans);font-size:13px;outline:none;box-sizing:border-box" placeholder="seu@email.com">
        </div>
        <div style="margin-bottom:20px">
          <label style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:6px">Senha</label>
          <input id="login-pass" type="password" style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;color:var(--text);font-family:var(--sans);font-size:13px;outline:none;box-sizing:border-box" placeholder="••••••••" onkeydown="if(event.key==='Enter')doLogin()">
        </div>
        <button onclick="doLogin()" style="width:100%;background:var(--green);color:#000;border:none;border-radius:6px;padding:12px;font-family:var(--sans);font-size:13px;font-weight:600;cursor:pointer;margin-bottom:10px">Entrar</button>
        <button onclick="doSignUp()" style="width:100%;background:transparent;color:var(--text3);border:1px solid var(--border);border-radius:6px;padding:10px;font-family:var(--sans);font-size:12px;cursor:pointer">Criar conta</button>
        <div style="text-align:center;margin-top:14px">
          <span style="font-size:11px;color:var(--text3);cursor:pointer" onclick="useDemo()">Continuar sem login (modo demo)</span>
        </div>
      </div>`;
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
}

function hideLoginScreen() {
  const el = document.getElementById('login-screen');
  if (el) el.style.display = 'none';
}

async function doLogin() {
  const email = document.getElementById('login-email')?.value?.trim();
  const pass  = document.getElementById('login-pass')?.value;
  const errEl = document.getElementById('login-error');
  if (!email || !pass) return;
  try {
    await loginWithEmail(email, pass);
  } catch (e) {
    if (errEl) { errEl.textContent = 'Email ou senha incorretos'; errEl.style.display = 'block'; }
  }
}

async function doSignUp() {
  const email = document.getElementById('login-email')?.value?.trim();
  const pass  = document.getElementById('login-pass')?.value;
  const errEl = document.getElementById('login-error');
  if (!email || !pass) {
    if (errEl) { errEl.style.background='var(--red-dim)'; errEl.style.color='var(--red)'; errEl.textContent = 'Preencha email e senha'; errEl.style.display = 'block'; }
    return;
  }
  if (pass.length < 6) {
    if (errEl) { errEl.style.background='var(--red-dim)'; errEl.style.color='var(--red)'; errEl.textContent = 'Senha precisa ter mínimo 6 caracteres'; errEl.style.display = 'block'; }
    return;
  }
  try {
    if (errEl) { errEl.style.background='var(--blue-dim)'; errEl.style.color='var(--blue)'; errEl.textContent = 'Criando conta...'; errEl.style.display = 'block'; }
    const { data, error } = await db.auth.signUp({ email, password: pass });
    if (error) throw error;
    // Se confirmação de email está desativada, já loga direto
    if (data?.session) {
      currentUser = data.session.user;
      await loadAllData();
      hideLoginScreen();
    } else {
      // Se confirmação está ativa, avisa
      if (errEl) { errEl.style.background='var(--green-dim)'; errEl.style.color='var(--green)'; errEl.textContent = '✓ Conta criada! Verifique seu email e clique no link de confirmação.'; errEl.style.display = 'block'; }
    }
  } catch (e) {
    console.error('Signup error:', e);
    if (errEl) {
      errEl.style.background='var(--red-dim)';
      errEl.style.color='var(--red)';
      errEl.textContent = e.message || 'Erro ao criar conta';
      errEl.style.display = 'block';
    }
  }
}

function useDemo() {
  hideLoginScreen();
  if (window.showToast) window.showToast('⚠', 'Modo demo — dados não são salvos');
}

// ─── Exposição global ─────────────────────────────────────────
window.DB             = db;
window.persistChange  = persistChange;
window.saveBatchTransactions = saveBatchTransactions;
window.logSync        = logSync;
window.loadAllData    = loadAllData;
window.logout         = logout;
window.currentUser    = () => currentUser;

// ─── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initAuth);
