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

## Estrutura

- `server.js` — Express + Socket.IO: posições, setores, convites, teletransporte e sinalização WebRTC.
- `map.js` — planta do escritório (setores, mesas, cadeiras), usada pelo servidor e pelo navegador.
- `app.js` — desenho do mapa e avatares (canvas), controles, chat e chamada de vídeo.
- `style.css`, `index.html` — interface.

O estado fica em memória: reiniciar o servidor zera quem está online (não há banco de dados nem login).
