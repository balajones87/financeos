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
    // Log para debug
    console.log('[Pluggy] Resposta connect-token:', JSON.stringify(data));
    // Pluggy retorna { accessToken: "..." }
    const token = data?.accessToken || data?.connectToken || data?.token;
    if (!token) throw new Error(`Token não encontrado. Resposta: ${JSON.stringify(data)}`);
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
      // 1. Busca o connectToken
      const url = existingItemId
        ? `${API}/connect-token?itemId=${existingItemId}`
        : `${API}/connect-token`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Token error: ${res.status}`);
      const data = await res.json();
      // Log completo para debug — ver no console do navegador
      this.log(`Resposta token: ${JSON.stringify(data)}`);
      console.log('[Pluggy] connect-token response FULL:', data);
      // Pluggy retorna { accessToken } ou aninhado em { data: { accessToken } }
      const connectToken = data.accessToken || data.connectToken || data.token
                        || data?.data?.accessToken || data?.data?.connectToken;
      if (!connectToken) throw new Error(`Token não encontrado. Resposta: ${JSON.stringify(data)}`);
      this.log(`Token obtido: ${connectToken.substring(0,20)}...`, 'success');

      // 2. Carrega SDK
      await loadPluggySDK();
      if (!window.PluggyConnect) throw new Error('SDK PluggyConnect não carregou');
      this.log(`SDK carregado, abrindo widget...`);

      // 3. Abre widget
      return new Promise((resolve, reject) => {
        try {
          const pluggyConnect = new window.PluggyConnect({
            connectToken,
            onSuccess: async (itemData) => {
              this.log(`✓ Conectado: ${itemData?.item?.connector?.name || localAccountId}`, 'success');
              const stored = loadStoredItems();
              const existing = stored.findIndex(s => s.localId === localAccountId);
              const entry = {
                localId:     localAccountId,
                itemId:      itemData?.item?.id || itemData?.itemId,
                connector:   itemData?.item?.connector?.name || localAccountId,
                connectedAt: new Date().toISOString(),
              };
              if (existing >= 0) stored[existing] = entry;
              else stored.push(entry);
              saveStoredItems(stored);
              resolve(entry.itemId);
            },
            onError: (error) => {
              const msg = error?.message || error?.error || JSON.stringify(error) || 'Erro desconhecido';
              this.log(`Erro na conexão: ${msg}`, 'error');
              reject(new Error(msg));
            },
            onClose: () => {
              this.log('Widget fechado');
              resolve(null);
            },
          });
          pluggyConnect.init();
        } catch (widgetErr) {
          const msg = widgetErr?.message || String(widgetErr) || 'Erro ao inicializar widget';
          this.log(`Erro init widget: ${msg}`, 'error');
          reject(new Error(msg));
        }
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
            if (window.TRANSACTIONS.length > 1000) window.TRANSACTIONS.length = 1000;
          }

          // Salva no Supabase
          if (window.saveBatchTransactions && categorized.length > 0) {
            try {
              await window.saveBatchTransactions(categorized);
              this.log(`✓ ${categorized.length} transações salvas no banco`, 'success');
            } catch(e) {
              this.log(`Aviso: erro ao salvar no banco: ${e.message}`, 'error');
            }
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

    // Recarrega transações do Supabase e atualiza toda a UI
    if (window.loadAllData) {
      await window.loadAllData();
    } else {
      if (window.renderDashboard)     window.renderDashboard();
      if (window.renderDashboardTx)  window.renderDashboardTx();
      if (window.renderTransactions) window.renderTransactions();
      if (window.renderCatBars)      window.renderCatBars();
      if (window.updatePendingBadge) window.updatePendingBadge();
    }

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
async function loadPluggySDK() {
  // Não precisamos mais do SDK externo — usamos iframe direto
  if (!window.PluggyConnect) {
    window.PluggyConnect = PluggyConnectIframe;
  }
}

// Implementação própria do widget via iframe
function PluggyConnectIframe({ connectToken, onSuccess, onError, onClose }) {
  let overlay = null;

  this.init = function() {
    // Cria overlay
    overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.7);
      z-index:99999;display:flex;align-items:center;justify-content:center;
    `;

    // Botão fechar
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText = `
      position:absolute;top:16px;right:16px;background:white;border:none;
      border-radius:50%;width:32px;height:32px;cursor:pointer;font-size:16px;
      display:flex;align-items:center;justify-content:center;z-index:100000;
    `;
    closeBtn.onclick = () => {
      document.body.removeChild(overlay);
      if (onClose) onClose();
    };

    // iframe com o widget Pluggy
    const iframe = document.createElement('iframe');
    iframe.src = `https://connect.pluggy.ai/?connectToken=${encodeURIComponent(connectToken)}`;
    iframe.style.cssText = `
      width:480px;height:680px;border:none;border-radius:12px;
      background:white;max-width:95vw;max-height:90vh;
    `;
    iframe.allow = 'clipboard-write';

    // Escuta mensagens do iframe (callback do widget)
    const messageHandler = (event) => {
      if (!event.origin.includes('pluggy.ai')) return;
      console.log('[Pluggy iframe] mensagem:', event.data);
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data?.event === 'SUCCESS' || data?.type === 'SUCCESS') {
          window.removeEventListener('message', messageHandler);
          document.body.removeChild(overlay);
          if (onSuccess) onSuccess(data);
        } else if (data?.event === 'ERROR' || data?.type === 'ERROR') {
          window.removeEventListener('message', messageHandler);
          document.body.removeChild(overlay);
          if (onError) onError(data);
        } else if (data?.event === 'CLOSE' || data?.type === 'CLOSE') {
          window.removeEventListener('message', messageHandler);
          document.body.removeChild(overlay);
          if (onClose) onClose();
        }
      } catch(e) {}
    };
    window.addEventListener('message', messageHandler);

    overlay.appendChild(closeBtn);
    overlay.appendChild(iframe);
    document.body.appendChild(overlay);
  };
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
