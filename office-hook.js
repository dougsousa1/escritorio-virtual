#!/usr/bin/env node
// Hook do Claude Code que mostra a sessão como um agente no Escritório Virtual.
//
// Variáveis de ambiente:
//   OFFICE_URL         endereço do escritório (ex.: https://escritorio-virtual-wr9e.onrender.com)
//   OFFICE_KEY         chave do servidor (AGENT_KEY no Render), se houver
//   OFFICE_OWNER       seu nome no escritório (padrão: usuário do computador)
//   OFFICE_AGENT_NAME  nome do agente (padrão: nome da pasta do projeto)
//
// Envia só: id da sessão (hash), evento, nome da ferramenta, nome do agente e dono.
// Nunca envia prompts, código, caminhos ou saída de comandos.
// Nunca trava o Claude Code: responde na hora e manda o aviso em segundo plano.

const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

if (process.argv[2] === 'send') {
  const url = (process.env.OFFICE_URL || '').replace(/\/+$/, '');
  if (!url) process.exit(0);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 70000); // o Render Free pode levar ~50 s para acordar
  fetch(url + '/api/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-office-key': process.env.OFFICE_KEY || '' },
    body: process.env.OFFICE_PAYLOAD,
    signal: ctrl.signal,
  }).catch(() => {}).finally(() => process.exit(0));
} else {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const h = JSON.parse(raw || '{}');
      if (!h.session_id || !process.env.OFFICE_URL) return;
      const payload = JSON.stringify({
        id: crypto.createHash('sha256').update(String(h.session_id)).digest('hex').slice(0, 16),
        event: h.hook_event_name,
        tool: h.tool_name || null,
        name: process.env.OFFICE_AGENT_NAME || path.basename(h.cwd || process.cwd()),
        owner: process.env.OFFICE_OWNER || os.userInfo().username,
      });
      const child = spawn(process.execPath, [__filename, 'send'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, OFFICE_PAYLOAD: payload },
      });
      child.unref();
    } catch { /* nunca atrapalha o Claude Code */ }
  });
}
