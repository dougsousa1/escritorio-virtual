# Escritório Virtual

Escritório 2D animado (Desenvolvimento, Estudo, Reunião, Descanso e OFF) para o time: cada pessoa aparece no setor em que está trabalhando, e dá pra **puxar alguém pra uma reunião rápida** com vídeo e áudio direto no navegador.

## Rodar

```bash
npm install
npm start
```

Abra http://localhost:3000.

## Como funciona

- **Entrar:** nome, cor da camisa, tom de pele e setor (Desenvolvimento, Estudo, Descanso ou OFF). Você aparece num lugar livre do setor.
- **Andar:** WASD/setas ou clique no mapa. A barra lateral mostra quem está em cada setor.
- **Puxar pra reunião:** clique no avatar da pessoa (ou no botão 📞 Puxar na lista). Ela recebe um convite com toque; se aceitar, as duas vão pra uma sala de reunião livre e a chamada de vídeo começa. Se você já está numa sala, a pessoa vem pra sua sala.
- **Sair da reunião:** volta pra mesa onde você estava.
- Entrar a pé numa sala de reunião **não** liga câmera/áudio: a chamada só começa quando alguém puxa outra pessoa.
- Quem está em **OFF** não pode ser puxado.
- Status (Disponível / Ocupado / Ausente), chat geral com balão em cima do avatar, emojis (teclas 1–6).

## Usar com o time pela internet

Câmera e microfone só funcionam em **HTTPS** (ou localhost). Opções:

- Túnel rápido: `cloudflared tunnel --url http://localhost:3000` (gera uma URL https para mandar pro time).
- Deploy no Render (plano Free): Web Service, build `npm install`, start `npm start`. No plano Free o servidor dorme após ~15 min sem uso e o primeiro acesso demora ~50 s.

As chamadas são WebRTC ponto a ponto (cada pessoa conecta com cada uma da sala) — ótimo para reuniões rápidas de 2 a 6 pessoas. Em redes muito restritas (corporativas) pode ser necessário um servidor TURN; adicione em `ICE` no topo de `app.js`.

## Agentes de IA no escritório (Claude Code)

Cada sessão do Claude Code pode aparecer no mapa como um robozinho:

- **Trabalhando:** senta numa mesa do Desenvolvimento, digita e mostra a ferramenta em uso (Edit, Bash, Read…).
- **Precisa de você** (pedido de permissão ou esperando resposta): fica com um "!" amarelo piscando e aparece um aviso.
- **Terminou / parado:** diz "Terminei!" e vai para o Descanso.
- Fechou a sessão: some do mapa (ou após 30 min sem sinal).

O hook envia só um id da sessão (hash), o evento, o nome da ferramenta, o nome do agente e o dono. Nunca envia prompts, código, caminhos ou saída de comandos.

### Instalar

1. Baixe `office-hook.js` deste repositório para uma pasta fixa, por exemplo `~/.claude/office-hook.js`.
2. No `~/.claude/settings.json` (vale para todas as sessões) ou no `.claude/settings.json` de um projeto, adicione:

```json
{
  "env": {
    "OFFICE_URL": "https://escritorio-virtual-wr9e.onrender.com",
    "OFFICE_KEY": "<chave do escritório>",
    "OFFICE_OWNER": "Seu nome"
  },
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "node ~/.claude/office-hook.js" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node ~/.claude/office-hook.js" }] }],
    "PreToolUse":       [{ "hooks": [{ "type": "command", "command": "node ~/.claude/office-hook.js" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "node ~/.claude/office-hook.js" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "node ~/.claude/office-hook.js" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "node ~/.claude/office-hook.js" }] }]
  }
}
```

O nome do agente é o nome da pasta do projeto; para trocar, defina `OFFICE_AGENT_NAME` (por exemplo no `.claude/settings.json` do projeto: "backend", "front", "PO"…).

No servidor, a variável `AGENT_KEY` define a chave; sem ela, qualquer um pode criar agentes.

## Estrutura

- `server.js` — Express + Socket.IO: posições, setores, convites, teletransporte e sinalização WebRTC.
- `map.js` — planta do escritório (setores, mesas, cadeiras), usada pelo servidor e pelo navegador.
- `app.js` — desenho do mapa e avatares (canvas), controles, chat e chamada de vídeo.
- `style.css`, `index.html` — interface.
- `office-hook.js` — hook do Claude Code que manda o estado da sessão para o escritório.

O estado fica em memória: reiniciar o servidor zera quem está online (não há banco de dados nem login).
