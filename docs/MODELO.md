# Modelo de dados

A configuração vive em `data/config.json`. O código está em `server/lib/model.js` (modelo, limites, operações)
e `server/lib/config.js` (gravação em disco). O player desenha em `public/player/player.js`.

## Estrutura

```json
{
  "version": 2,
  "rev": 42,
  "output": { "width": 1920, "height": 1080 },
  "convert": { "maxWidth": 960, "maxHeight": 540, "fps": 30, "process": true },
  "splash": true,
  "pinHash": "",
  "layers": [ { "...": "ver abaixo" } ]
}
```

| Campo | Descrição |
|---|---|
| `version` | Versão do formato (para migrações futuras). |
| `rev` | Sobe a cada alteração. Serve para os clientes saberem se estão atualizados. |
| `output` | Resolução de saída: só `1920×1080` ou `1280×720`. Outro valor volta a 1920×1080. |
| `convert` | Conversão no upload: caixa máxima (`maxWidth`×`maxHeight`, qualquer inteiro de 64 a 4096; por omissão 960×540), `fps` (25 ou 30) e `process` (`false` = guarda os vídeos como vêm). Cada upload pode levar o seu tamanho (`X-Max-Size`). |
| `splash` | `true` = mostra o ecrã com o QR code e o endereço do painel nos primeiros 10 segundos depois de o player arrancar (com `localhost:PORTA` e o endereço da rede). |
| `pinHash` | Hash scrypt com sal do PIN (4 a 8 dígitos). Vazio = sem PIN. **Nunca é enviado aos clientes**; estes recebem apenas `hasPin`. |
| `layers` | Lista **da de baixo para a de cima**: índice 0 = fundo, último = topo (é o z-index). Máximo 32. |

## Layer

| Campo | Padrão | Limites | Significado |
|---|---|---|---|
| `id` | gerado | `[\w-]{1,40}` | Identificador estável; nunca muda. |
| `name` | `Layer` | 80 car. | Nome no painel. |
| `visible` | `true` | | Escondida = fica em pausa. |
| `locked` | `false` | | Bloqueada: **só afeta o painel** (não se escolhe nem se move na pré-visualização). O player ignora-o. Duplicar dá uma cópia desbloqueada. |
| `source` | `video` | `video`\|`color` | De onde vem o conteúdo: o ficheiro `video` ou a cor sólida `color`. Ao passar para `color`, o `video` fica guardado (voltar a `video` retoma-o). |
| `video` | `null` | nome de ficheiro | Ficheiro em `data/media/` (só o nome, sem caminhos). Ignorado com `source` = `color`. |
| `color` | `#ffffff` | `#rrggbb` | Cor sólida (com `source` = `color`). Aceita `#rgb`; guarda-se sempre `#rrggbb` em minúsculas. |
| `mask` | `null` | nome de ficheiro | PNG em `data/media/`. |
| `maskScale` | 1 | 0,01 a 20 | Escala da máscara dentro da caixa (1 = tamanho exato do PNG). |
| `maskMode` | `alpha` | `alpha`\|`luminance` | `alpha`: opaco = visível. `luminance`: branco = visível. |
| `vmask` | `null` | ver abaixo | Máscara desenhada (vetorial). Se existir, **substitui o PNG** e define a caixa. |
| `videoScale` | 1 | 0,01 a 20 | Escala extra do vídeo, por cima do *cover* (1 = encher a caixa). |
| `videoOffsetX/Y` | 0 | ±5000 | Deslocamento do vídeo dentro da caixa (px da caixa). |
| `x`, `y` | centro do ecrã | ±10000 | Posição do **centro** da layer, em píxeis de saída. |
| `scale` | 1 | 0,01 a 20 | Escala da layer, em torno do seu centro. |
| `rotation` | 0 | ±360 | Rotação da layer em graus, sentido horário, em torno do centro. |
| `pins` | 4×`{0,0}` | ±3000 | Corner pin: deslocamento de cada canto, em píxeis de saída. Ordem: TL, TR, BR, BL. |
| `glitch` | tudo desligado | ver "Glitch" | Efeitos glitch por layer (stutter, jitter, slices, RGB, noise, roll), cada um com ON/OFF e intensidade. |
| `mesh` | 1×1 | ver abaixo | Grelha de pontos por cima do corner pin. 1×1 = só corner pin. |

Valores fora dos limites são cortados; valores inválidos voltam ao padrão. Nomes de ficheiro com `/`, `\` ou
a começar por `.` são rejeitados (sem `../`).

## Máscara desenhada (`vmask`)

```json
{ "width": 1920, "height": 1080, "feather": 0, "invert": false,
  "shapes": [ { "type": "poly", "op": "add", "points": [[100, 100], [600, 80], [700, 600]] },
              { "type": "ellipse", "op": "sub", "cx": 400, "cy": 360, "rx": 100, "ry": 100 } ] }
```

| Campo | Limites | Significado |
|---|---|---|
| `width`, `height` | 16 a 4096 | Tamanho da máscara: faz o papel do tamanho do PNG (define a caixa da layer). |
| `feather` | 0 a 200 | Desfoque das bordas, em píxeis da máscara. |
| `invert` | | Troca o que é visível e escondido. |
| `shapes` | até 32 | Formas, aplicadas por ordem. `op`: `add` mostra, `sub` recorta. |
| `points` | até 256 por polígono, 1500 ao todo | Coordenadas em píxeis da máscara (±20000, 1 casa decimal). |

O player e o painel convertem as formas num SVG (`public/shared/vmask.js`) usado como `mask-image`, por isso o
resto da cadeia (passos abaixo) é igual ao de um PNG. As formas só existem na configuração: não há ficheiro.

## Ordem de aplicação das transformações

**A máscara define a caixa.** A caixa da layer tem o tamanho nativo do PNG da máscara (ex.: 800×600) e é ela
que fixa a posição global e a proporção da layer. Sem máscara, a caixa tem o tamanho nativo do vídeo. Assim,
trocar de vídeo (de qualquer resolução ou proporção) não mexe na máscara: só muda o conteúdo lá dentro.
Numa layer de **cor sólida** (`source` = `color`) não há vídeo: sem máscara a caixa tem 1920×1080
(`Geometry.COLOR_SIZE`) e a cor enche sempre a caixa toda (`videoScale`, `videoOffsetX/Y` e `speed` não se aplicam).

Para cada layer, por esta ordem:

1. **Vídeo dentro da caixa (*cover*).** O vídeo é escalado até encher a caixa sem se deformar (o excesso é
   cortado), centrado. Por cima disso aplicam-se `videoScale` (em torno do centro) e `videoOffsetX/Y`.
2. **Máscara no espaço da layer.** A máscara tem o tamanho da caixa, escalada por `maskScale` (1 = exata) e
   centrada. Aplica-se à caixa já com o vídeo. Ainda não há posição nem corner pin: a máscara acompanha tudo
   o que vem a seguir.
3. **Posição, escala e rotação da layer.** A caixa é escalada por `scale` em torno do seu centro, rodada por
   `rotation` (em torno do mesmo centro) e colocada com o centro em `(x, y)`, no espaço da saída.
4. **Corner pin (afinação final).** Cada um dos 4 cantos da caixa, já posicionada, é deslocado por `pins[i]`.
   O resultado é uma transformação de perspetiva (homografia) da caixa para o quadrilátero final.

5. **Mesh (opcional).** Com `mesh` maior que 1×1, cada ponto da grelha é ainda deslocado (ver "Mesh" abaixo).

Os passos 3 e 4 resumem-se a uma única `matrix3d` (sem mesh). Como a máscara está no mesmo elemento que recebe a
`matrix3d`, ela é deformada pelo corner pin em conjunto com o vídeo. O código está em
`public/shared/geometry.js`, usado pelo player e pela pré-visualização do painel (para coincidirem).

## Mesh (`mesh`)

```json
{ "cols": 3, "rows": 2, "smooth": false,
  "pts": [ {"x":0,"y":0}, {"x":0,"y":0}, {"x":0,"y":0}, {"x":0,"y":0},
           {"x":0,"y":0}, {"x":12,"y":-30}, {"x":0,"y":0}, {"x":0,"y":0},
           {"x":0,"y":0}, {"x":0,"y":0}, {"x":0,"y":0}, {"x":0,"y":0} ] }
```

- `cols` × `rows`: número de **células**, de 1 a 4 em cada eixo (16 presets: 1×1, 1×2 ... 4×4). **1×1 é o corner pin
  normal** e as layers continuam a ser desenhadas com uma só `matrix3d`.
- `pts`: `(cols+1)·(rows+1)` pontos, linha a linha (índice = `linha·(cols+1) + coluna`). Cada um é o deslocamento, em
  píxeis de saída, em relação à posição que a homografia da layer (posição, escala, rotação, corner pin e espelho)
  lhe dá. Os **4 cantos ficam sempre a 0**: são as pegas do corner pin. Com todos os pontos a 0 o resultado é
  exatamente o do corner pin. Limite de cada valor: ±3000.
- `smooth`: `false` = interpolação linear (arestas retas entre células, bom para esquinas); `true` = suave
  (Catmull-Rom, a curva passa pelos pontos, bom para colunas e superfícies curvas).
- O vídeo e a máscara (PNG ou desenhada) deformam-se juntos.
- Mudar a grelha no painel repõe os pontos na grelha direita.

Uma layer com mesh (mais de 1×1) é desenhada num `<canvas>` WebGL (o vídeo e a máscara são texturas), em
`public/shared/mesh.js`; o `matrix3d` e o `mask-image` CSS deixam de ser usados nessa layer. Os FX e o modo de mistura
continuam a funcionar. O Chromium limita-se a ~16 contextos WebGL ativos: usa mesh só nas layers que precisam.
Sem WebGL, a layer volta ao corner pin.

## Operações

Todas as alterações passam por `applyOp` (função pura: devolve uma configuração nova e sobe o `rev`). Será
este o formato das mensagens do painel (Fase 3).

| `op` | Parâmetros | Efeito |
|---|---|---|
| `addLayer` | `layer?` | Acrescenta uma layer ao topo. |
| `removeLayer` | `id` | Remove. |
| `duplicateLayer` | `id` | Copia para logo acima do original, com id novo e deslocada 40 px. |
| `moveLayer` | `id`, `index` | Reordena (0 = fundo). |
| `updateLayer` | `id`, `patch` | Altera só os campos permitidos (nunca o `id`). |
| `setOutput` | `width`, `height` | Muda a resolução e escala `x`, `y`, `scale`, `pins` e os pontos da `mesh` para manter a composição. |
| `setConvert` | `width`, `height`, `fps`, `process` | Definições da conversão no upload (tamanho 64 a 4096). |
| `setSplash` | `enabled` | Liga/desliga o ecrã do QR code. |
| `setPin` | `pin` | 4 a 8 dígitos; `""` remove o PIN. |

Operações inválidas lançam `OpError` e não alteram nada.

## Persistência e segurança dos dados

- **Escrita atómica:** grava num ficheiro temporário no mesmo diretório, faz `fsync` e só depois `rename`.
  Se a corrente falhar a meio, `config.json` fica intacto.
- **Cópia anterior:** antes de cada substituição, a versão anterior fica em `config.json.bak`.
- **Recuperação no arranque:** temporários deixados por uma falha são apagados. Se `config.json` estiver
  corrompido, copia-o para `config.json.corrupt-<hora>` e usa o `.bak`. Se também falhar, arranca vazio.
- **Junção de escritas:** alterações seguidas (ex.: arrastar um slider) vão para a memória e para os
  clientes de imediato, mas só vão para o disco 250 ms depois da última. `flush()` grava logo ao terminar o servidor.
- **Edição à mão:** o servidor vigia o ficheiro e recarrega-o se mudar por fora. Se estiver inválido, ignora-o.

## Testes

`cd server && npm test` (30 testes: normalização, limites, operações, máscara desenhada, geometria, PIN, falhas de escrita, recuperação).

## Estado fora da configuração (não vai para `config.json`)

- **RUN / EDIT**: estado do servidor. Arranca sempre em RUN. Mensagens do painel: `{type:'edit', on}` e `{type:'edit-ping'}`; o servidor responde a todos com
  `{type:'edit', editing, editUntil, reason}`. O EDIT termina sozinho sem atividade (5 min) ou quando o último painel se desliga (15 s de tolerância). O player liga-se a `/ws?role=player`; qualquer outra ligação conta como painel.
- **Player ligado/desligado**: `POST /api/player` com `{"on": true|false}` ou `{"toggle": true}`; o servidor emite `{type:'player', on}`. Desligado = os vídeos param.
- **Re-conversão**: `POST /api/media/:name/resize` com `{width, height, replace?}` cria `nome_resized_LxA.ext`. Com `replace: true` as layers que usavam o original passam à cópia,
  compensando `scale` e `videoOffsetX/Y` (só em layers sem máscara) para manterem o mesmo tamanho no ecrã.

## Velocidade e efeitos (FX) por layer

Cada layer tem `speed` (0.1–4, 1 = normal) e um objeto `fx`:
`on` (bypass), `brightness`, `contrast`, `saturate` (%, 100 = normal), `hue` (graus), `invert`, `grayscale`, `sepia` (%),
`blur` (px), `opacity` (%) e `blend` (modo de mistura CSS). Limites em `FX_LIMITS` (`server/lib/model.js`) e `public/shared/fx.js`.

- **Speed**: `playbackRate` dos dois `<video>` da layer. A antecedência com que o vídeo seguinte arranca no loop sem salto acompanha a velocidade.
- **FX**: filtros CSS, `opacity` e `mix-blend-mode` no elemento da layer. Aplicam-se antes da máscara (um blur fica recortado por ela) e
  antes da transformação final. Em tempo real, sem reconverter vídeos. `fx.on = false` ignora os efeitos sem perder os valores.
- A pré-visualização do painel aplica os mesmos efeitos às miniaturas (a velocidade só se vê no player).

### Glitch (`glitch`)

```json
{ "stutter": { "on": false, "intensity": 50 }, "jitter": { "on": true, "intensity": 30 }, "slices": { "on": false, "intensity": 50 },
  "rgb": { "on": true, "intensity": 80 }, "noise": { "on": false, "intensity": 50 }, "roll": { "on": false, "intensity": 50 } }
```

Efeitos desenhados em canvas 2D (`public/shared/glitch.js`, vindos do projeto AliciaOla). Cada efeito tem o seu interruptor
`on` (por omissão desligado) e a sua `intensity` (0 a 100, padrão 50). O formato antigo (booleanos e uma `intensity`
partilhada) é convertido ao ler. As rajadas do `rgb` e do `slices` partilham o mesmo ritmo, dado pela maior das duas intensidades.

| Efeito | O que faz |
|---|---|
| `stutter` | Repete em ciclo os últimos 3 a 10 frames (guarda 12, a no máximo 640 de largura). |
| `jitter` | O frame treme uns píxeis. |
| `slices` | Faixas horizontais empurradas para o lado, em rajadas curtas. |
| `rgb` | Os canais vermelho, verde e azul separam-se, em rajadas. |
| `noise` | Grão e scanlines. |
| `roll` | A imagem desliza na vertical. |

Com algum ligado (só em layers de vídeo e com `fx.on`), o player desenha o vídeo num `<canvas>` (no máximo 960 de largura)
com o tamanho e a posição do vídeo na caixa; os `<video>` continuam a descodificar, invisíveis. Tudo o resto (máscara,
transform, corner pin, mesh, filtros CSS) aplica-se por cima, como num vídeo normal. Um só loop a ~30 fps serve todas as
layers com glitch e só existe enquanto houver alguma. As zonas que ficam a descoberto (jitter, roll) são transparentes.
A pré-visualização do painel não mostra o glitch (é uma miniatura parada).

## Espelho

`mirrorX` e `mirrorY` (booleanos) viram a layer, máscara incluída, dentro do quadrilátero final: trocam-se os cantos de destino da homografia, por isso o corner pin e as pegas não se mexem.
