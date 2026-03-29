/**
 * FinanceOS — Pluggy Sync Engine
 * pluggy-sync.js
 * 
 * Inclua ANTES do </body> no index.html:
 *   <script src="pluggy-sync.js"></script>
 * 
 * MAPEAMENTO DAS SUAS CONTAS:
 * Após conectar cada banco no widget, salve o itemId e accountId correspondentes abaixo.
 */
 
// ─── Configuração das suas contas ────────────────────────────
// Preencher após primeira conexão via widget
const PLUGGY_ACCOUNTS_MAP = [
  // { localId: 'nubank-pf',  itemId: 'SEU_ITEM_ID', accountId: 'SEU_ACCOUNT_ID', name: 'Nubank PF'         },
  // { localId: 'nubank-pj',  itemId: 'SEU_ITEM_ID', accountId: 'SEU_ACCOUNT_ID', name: 'Nubank PJ'         },
  // { localId: 'itau',       itemId: 'SEU_ITEM_ID', accountId: 'SEU_ACCOUNT_ID', name: 'Itaú Personnalité' },
  // { localId: 'unicred',    itemId: 'SEU_ITEM_ID', accountId: 'SEU_ACCOUNT_ID', name: 'Unicred'           },
  // { localId: 'energia-pj', itemId: 'SEU_ITEM_ID', accountId: 'SEU_ACCOUNT_ID', name: 'Energia PJ'        },
];
 
// ─── API base (vai para o Netlify Function) ───────────────────
const API = '/.netlify/functions/pluggy-token';
 
// ─── Storage (localStorage para persistir itemIds) ────────────
const STORAGE_KEY = 'financeos_pluggy_items';
 
function loadStoredItems() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}
 
function saveStoredItems(items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}
 
// ─── Pluggy API client ────────────────────────────────────────
const PluggyAPI = {
  async getConnectToken(itemId = null) {
    const url = itemId ? `${API}/connect-token?itemId=${itemId}` : `${API}/connect-token`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Token error: ${res.status}`);
    const data = await res.json();
    // Pluggy pode retornar accessToken ou connectToken dependendo da versão
    const token = data.accessToken || data.connectToken || data.token;
    if (!token) throw new Error(`Token não encontrado na resposta: ${JSON.stringify(data)}`);
    return token;
  },
 
  async getAccounts(itemId) {
    const res  = await fetch(`${API}/accounts?itemId=${itemId}`);
    if (!res.ok) throw new Error(`Accounts error: ${res.status}`);
    return (await res.json()).results || [];
  },
 
  async getTransactions(accountId, from, to) {
    const params = new URLSearchParams({ accountId, pageSize: '200' });
    if (from) params.append('from', from);
    if (to)   params.append('to', to);
    const res = await fetch(`${API}/transactions?${params}`);
    if (!res.ok) throw new Error(`Transactions error: ${res.status}`);
    return (await res.json()).results || [];
  },
 
  async getItem(itemId) {
    const res = await fetch(`${API}/item?itemId=${itemId}`);
    if (!res.ok) throw new Error(`Item error: ${res.status}`);
    return res.json();
  },
};
 
// ─── Normalizar transação Pluggy → formato FinanceOS ─────────
function normalizeTx(pluggyTx, localAccountId) {
  // Pluggy usa amount positivo p/ crédito, negativo p/ débito — igual ao nosso formato
  const amount = pluggyTx.amount;
  const desc   = (pluggyTx.description || pluggyTx.descriptionRaw || '').toUpperCase().trim();
 
  // Detecta tipo de transferência automaticamente
  let txType = amount > 0 ? 'credit' : 'debit';
  const internalKeywords = [
    'TRANSFERENCIA ENVIADA|F', 'TRANSFERÊNCIA ENTRE CONTAS', 'PAGAMENTO FATURA',
    'PAG FATURA', 'PAGTO FATURA', 'REND PAGO APLIC', 'APLICACAO AUTOMATICA',
    'RESGATE AUTOMATICO', 'TRANSF PROPRIA',
  ];
  if (internalKeywords.some(kw => desc.includes(kw))) txType = 'transfer_internal';
 
  return {
    id:          pluggyTx.id,
    date:        pluggyTx.date?.split('T')[0] || new Date().toISOString().split('T')[0],
    desc:        pluggyTx.description || pluggyTx.descriptionRaw || 'Sem descrição',
    amount:      amount,
    account:     localAccountId,
    txType:      txType,
    category:    null,
    origin:      'pending',
    cardTx:      pluggyTx.paymentMethod === 'CREDIT_CARD',
    external_id: pluggyTx.id, // para deduplicação
    raw_data:    pluggyTx,
  };
}
 
// ─── Deduplicação ─────────────────────────────────────────────
function deduplicateTx(newTxs, existingTxs) {
  const existingIds = new Set(existingTxs.map(t => t.external_id || t.id));
  return newTxs.filter(t => !existingIds.has(t.external_id || t.id));
}
 
// ─── Auto-categorizar usando as regras existentes ─────────────
function autoCategorizeFromRules(tx) {
  if (window.RULES && window.autoCategorizeTx) {
    const result = window.autoCategorizeTx(tx);
    if (result.category) {
      tx.category = result.category;
      tx.origin   = result.origin;
    }
  }
  return tx;
}
 
// ─── Match com recorrentes ────────────────────────────────────
function matchRecorrentes(tx) {
  if (!window.RECORRENTES) return tx;
  const desc = tx.desc.toUpperCase();
  const rec  = window.RECORRENTES.find(r =>
    r.keyword && desc.includes(r.keyword.toUpperCase()) && r.active
  );
  if (rec && !tx.category) {
    tx.category = rec.category;
    tx.origin   = 'rule';
  }
  return tx;
}
 
// ─── Engine principal de sync ─────────────────────────────────
const PluggySync = {
  _log: [],
 
  log(msg, type = 'info') {
    const entry = { msg, type, time: new Date().toLocaleTimeString('pt-BR') };
    this._log.unshift(entry);
    console.log(`[Pluggy ${type.toUpperCase()}] ${msg}`);
    // Atualiza UI de log se existir
    const logEl = document.getElementById('sync-log');
    if (logEl) {
      logEl.innerHTML = this._log.slice(0, 20).map(e => `
        <div style="padding:4px 0;border-bottom:1px solid var(--border);font-size:11px;color:${e.type==='error'?'var(--red)':e.type==='success'?'var(--green)':'var(--text2)'}">
          <span style="color:var(--text3);font-family:var(--mono)">${e.time}</span> ${e.msg}
        </div>`).join('');
    }
  },
 
  // Abre o widget Pluggy Connect para conectar um banco
  async openConnect(localAccountId, existingItemId = null) {
    this.log(`Abrindo widget para ${localAccountId}...`);
 
    try {
      const connectToken = await PluggyAPI.getConnectToken(existingItemId);
 
      // Carrega o SDK do Pluggy dinamicamente
      await loadPluggySDK();
 
      return new Promise((resolve, reject) => {
        const pluggyConnect = new PluggyConnect({
          connectToken,
          onSuccess: async (itemData) => {
            this.log(`✓ Conectado: ${itemData.item?.connector?.name || localAccountId}`, 'success');
 
            // Salva o itemId localmente
            const stored = loadStoredItems();
            const existing = stored.findIndex(s => s.localId === localAccountId);
            const entry = {
              localId:   localAccountId,
              itemId:    itemData.item.id,
              connector: itemData.item?.connector?.name || localAccountId,
              connectedAt: new Date().toISOString(),
            };
            if (existing >= 0) stored[existing] = entry;
            else stored.push(entry);
            saveStoredItems(stored);
 
            resolve(itemData.item.id);
          },
          onError: (error) => {
            this.log(`Erro na conexão: ${error.message}`, 'error');
            reject(error);
          },
          onClose: () => {
            this.log('Widget fechado');
            resolve(null);
          },
        });
 
        pluggyConnect.init();
      });
    } catch (err) {
      this.log(`Erro ao abrir widget: ${err.message}`, 'error');
      throw err;
    }
  },
 
  // Sincroniza todas as contas conectadas
  async syncAll(daysBack = 60) {
    const stored = loadStoredItems();
    if (stored.length === 0) {
      this.log('Nenhuma conta conectada. Use o botão "Conectar Conta" primeiro.', 'error');
      return { imported: 0, categorized: 0, duplicates: 0 };
    }
 
    let totalImported   = 0;
    let totalCategorized = 0;
    let totalDuplicates  = 0;
 
    const to   = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
 
    this.log(`Iniciando sync — ${from} até ${to}...`);
 
    for (const conn of stored) {
      try {
        this.log(`Buscando contas de ${conn.connector || conn.localId}...`);
 
        // Busca contas do item
        const accounts = await PluggyAPI.getAccounts(conn.itemId);
 
        for (const acc of accounts) {
          // Atualiza saldo
          const localAcc = window.ACCOUNTS?.find(a => a.id === conn.localId);
          if (localAcc && acc.balance != null) {
            localAcc.balance = acc.balance;
            this.log(`Saldo ${conn.localId}: R$ ${acc.balance.toFixed(2)}`, 'success');
          }
 
          // Busca transações
          const pluggyTxs = await PluggyAPI.getTransactions(acc.id, from, to);
          this.log(`${pluggyTxs.length} transações de ${conn.connector || conn.localId}`);
 
          // Normaliza
          const normalized = pluggyTxs.map(t => normalizeTx(t, conn.localId));
 
          // Deduplica
          const existingTxs  = window.TRANSACTIONS || [];
          const newTxs       = deduplicateTx(normalized, existingTxs);
          totalDuplicates   += normalized.length - newTxs.length;
 
          // Auto-categoriza
          const categorized = newTxs.map(tx => {
            tx = matchRecorrentes(tx);
            tx = autoCategorizeFromRules(tx);
            if (tx.category) totalCategorized++;
            return tx;
          });
 
          // Injeta no array global (início = mais recente)
          if (window.TRANSACTIONS) {
            window.TRANSACTIONS = [...categorized, ...window.TRANSACTIONS];
            // Limita a 1000 transações em memória
            if (window.TRANSACTIONS.length > 1000) window.TRANSACTIONS.length = 1000;
          }
 
          totalImported += categorized.length;
        }
 
      } catch (err) {
        this.log(`Erro em ${conn.localId}: ${err.message}`, 'error');
      }
    }
 
    this.log(
      `✓ Sync completo — ${totalImported} novas, ${totalCategorized} categorizadas, ${totalDuplicates} duplicatas ignoradas`,
      'success'
    );
 
    // Atualiza a UI
    if (window.renderDashboard)    window.renderDashboard();
    if (window.renderDashboardTx) window.renderDashboardTx();
    if (window.renderCatBars)     window.renderCatBars();
    if (window.updatePendingBadge) window.updatePendingBadge();
 
    return { imported: totalImported, categorized: totalCategorized, duplicates: totalDuplicates };
  },
 
  // Status das conexões
  getConnectionStatus() {
    return loadStoredItems();
  },
 
  // Desconectar uma conta
  async disconnect(localId) {
    const stored  = loadStoredItems();
    const conn    = stored.find(s => s.localId === localId);
    if (!conn) return;
 
    try {
      await fetch(`${API}/delete-item`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: conn.itemId }),
      });
    } catch (e) {
      console.warn('Erro ao deletar item na Pluggy:', e);
    }
 
    const updated = stored.filter(s => s.localId !== localId);
    saveStoredItems(updated);
    this.log(`Conta ${localId} desconectada`, 'success');
  },
};
 
// ─── Carrega SDK Pluggy dinamicamente ─────────────────────────
function loadPluggySDK() {
  return new Promise((resolve, reject) => {
    if (window.PluggyConnect) { resolve(); return; }
    const script  = document.createElement('script');
    script.src    = 'https://cdn.pluggy.ai/pluggy-connect/v2/pluggy-connect.js';
    script.onload  = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}
 
// ─── Exposição global ─────────────────────────────────────────
window.PluggySync = PluggySync;
window.PluggyAPI  = PluggyAPI;
window.loadStoredItems = loadStoredItems;
 
// ─── Auto-sync ao carregar (se tiver contas conectadas) ───────
document.addEventListener('DOMContentLoaded', async () => {
  const stored = loadStoredItems();
  if (stored.length > 0) {
    console.log(`[Pluggy] ${stored.length} conta(s) conectada(s). Iniciando sync automático...`);
    // Delay de 2s para deixar o app carregar primeiro
    setTimeout(() => PluggySync.syncAll(30), 2000);
  }
});
