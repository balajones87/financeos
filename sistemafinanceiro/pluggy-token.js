/**
 * FinanceOS — Pluggy Token Function
 * Netlify Edge Function que protege as API keys da Pluggy
 * 
 * DEPLOY: Esta função roda no servidor Netlify.
 * As chaves NUNCA ficam expostas no frontend.
 * 
 * Configurar no painel Netlify > Environment Variables:
 *   PLUGGY_CLIENT_ID     = sua Client ID do painel pluggy.ai
 *   PLUGGY_CLIENT_SECRET = sua Client Secret do painel pluggy.ai
 */

const PLUGGY_BASE_URL = 'https://api.pluggy.ai';

// ─── Helpers ────────────────────────────────────────────────
async function pluggyAuth() {
  const res = await fetch(`${PLUGGY_BASE_URL}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId:     process.env.PLUGGY_CLIENT_ID,
      clientSecret: process.env.PLUGGY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Pluggy auth failed: ${res.status}`);
  const data = await res.json();
  return data.apiKey; // API key temporária (2h de validade)
}

// ─── Handler principal ───────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type':                 'application/json',
  };

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // Valida env vars
  if (!process.env.PLUGGY_CLIENT_ID || !process.env.PLUGGY_CLIENT_SECRET) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET não configurados nas Environment Variables do Netlify'
      }),
    };
  }

  try {
    const path   = event.path.replace('/.netlify/functions/pluggy-token', '');
    const method = event.httpMethod;

    // ── Rota: GET /connect-token ─────────────────────────────
    // Gera um connect_token para o widget de conexão do banco
    if (path === '/connect-token' || path === '') {
      const apiKey = await pluggyAuth();

      // itemId opcional — para reconectar uma conta existente
      const body = event.queryStringParameters?.itemId
        ? { itemId: event.queryStringParameters.itemId }
        : {};

      const res = await fetch(`${PLUGGY_BASE_URL}/connect_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY':    apiKey,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      console.log('[pluggy-token] connect_token resposta:', JSON.stringify(data));
      // Normaliza: sempre retorna { accessToken } independente do formato da Pluggy
      const accessToken = data.accessToken || data.connectToken || data.token
                       || data?.data?.accessToken;
      if (!accessToken) {
        console.error('[pluggy-token] Token não encontrado na resposta:', JSON.stringify(data));
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Token não encontrado', raw: data }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ accessToken }) };
    }

    // ── Rota: GET /accounts?itemId=... ───────────────────────
    if (path === '/accounts') {
      const itemId = event.queryStringParameters?.itemId;
      if (!itemId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'itemId obrigatório' }) };

      const apiKey = await pluggyAuth();
      const res    = await fetch(`${PLUGGY_BASE_URL}/accounts?itemId=${itemId}`, {
        headers: { 'X-API-KEY': apiKey },
      });
      const data = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    // ── Rota: GET /transactions?accountId=...&from=...&to=... ─
    if (path === '/transactions') {
      const { accountId, from, to, pageSize = '200', page = '1' } = event.queryStringParameters || {};
      if (!accountId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'accountId obrigatório' }) };

      const apiKey = await pluggyAuth();
      const params = new URLSearchParams({ accountId, pageSize, page });
      if (from) params.append('from', from);
      if (to)   params.append('to', to);

      const res  = await fetch(`${PLUGGY_BASE_URL}/transactions?${params}`, {
        headers: { 'X-API-KEY': apiKey },
      });
      const data = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    // ── Rota: GET /item?itemId=... ───────────────────────────
    if (path === '/item') {
      const itemId = event.queryStringParameters?.itemId;
      if (!itemId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'itemId obrigatório' }) };

      const apiKey = await pluggyAuth();
      const res    = await fetch(`${PLUGGY_BASE_URL}/items/${itemId}`, {
        headers: { 'X-API-KEY': apiKey },
      });
      const data = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    // ── Rota: POST /item (deletar/desconectar) ───────────────
    if (path === '/delete-item' && method === 'POST') {
      const { itemId } = JSON.parse(event.body || '{}');
      if (!itemId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'itemId obrigatório' }) };

      const apiKey = await pluggyAuth();
      await fetch(`${PLUGGY_BASE_URL}/items/${itemId}`, {
        method: 'DELETE',
        headers: { 'X-API-KEY': apiKey },
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Rota não encontrada' }) };

  } catch (err) {
    console.error('Pluggy function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
