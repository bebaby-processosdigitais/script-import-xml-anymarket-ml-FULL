# Robô de Importação Full — Anymarket → Sankhya TGFIXN

Importa automaticamente os XMLs de documentos fiscais do Mercado Livre Full (via API da
Anymarket) para dentro do Sankhya, gravando na tabela `TGFIXN` para que o motor de
importação do ERP processe e gere as notas.

**Última atualização:** 27/08/2026

| Arquivo | O que é |
|---|---|
| `robo_full_tgfixn_lote.js` | **Produção.** Vai em Ações Agendadas |
| `robo_full_teste_simulacao.js` | **Teste.** Simula sem tocar na `TGFIXN` |
| `sonda_diagnostico_parceiros.js` | Diagnóstico agregado de parceiros por tipo |
| `estado_projeto_tgfixn_2026-08-27.md` | Handoff completo: investigação e engenharia reversa |

---

## Índice

1. [O que ele faz](#1-o-que-ele-faz)
2. [Como funciona](#2-como-funciona)
3. [Instalação](#3-instalação)
4. [Configuração](#4-configuração)
5. [Como testar antes de agendar](#5-como-testar-antes-de-agendar)
6. [Agendamento](#6-agendamento)
7. [Operação e monitoramento](#7-operação-e-monitoramento)
8. [Habilitando novos tipos de documento](#8-habilitando-novos-tipos-de-documento)
9. [Solução de problemas](#9-solução-de-problemas)
10. [Limitações conhecidas](#10-limitações-conhecidas)
11. [Decisões de projeto](#11-decisões-de-projeto)
12. [Pendências abertas](#12-pendências-abertas)

---

## 1. O que ele faz

```
Anymarket API → filtra tipos habilitados → descarta o que já existe
              → baixa só os XMLs novos → grava na TGFIXN (STATUS 0)
              → motor do Sankhya processa e gera a nota
```

O robô **não** monta a nota fiscal, **não** define a TOP (tipo de operação) e **não**
cadastra parceiro. Isso é trabalho do motor de importação do Sankhya, que aplica as
"regras do Full" configuradas pelo Paulo Vieira.

### O que ele resolve

A integração terceirizada (Tem Api) parou de trazer as notas do Full em **29/06/2026**.
Desde então, notas de venda e devolução do Full não caem mais no Sankhya
automaticamente. Este robô substitui essa função.

---

## 2. Como funciona

Quatro etapas, separadas de propósito.

### Etapa 1 — Carrega o que já existe (2 queries)

```sql
SELECT NOMEARQUIVO FROM TGFIXN WHERE NOMEARQUIVO LIKE 'INVOICE-%'
SELECT CHAVEACESSO FROM TGFIXN WHERE CHAVEACESSO IS NOT NULL
```

Dois conjuntos em memória. Depois disso, **zero consultas por documento**.

### Etapa 2 — Varre a listagem (sem baixar nada)

Pagina a API montando uma fila de candidatas, filtrando por tipo e por `NOMEARQUIVO`.
Nenhum download de XML acontece aqui — é o que permite varrer ~1000 documentos de forma
barata.

A fila coleta `LIMITE_LOTE × FILA_FOLGA` candidatas, porque parte delas vai morrer no
dedup por chave. Sem essa folga, uma rodada com muitas duplicatas gravaria quase nada.

### Etapa 3 — Baixa, deduplica por chave e grava

Cada nota isolada em `try/catch`. Um XML corrompido incrementa o contador de falhas e o
lote continua. A gravação para ao atingir `LIMITE_LOTE`.

### Etapa 4 — Log

Grava **uma** linha de resumo na `AD_TESTENOTA`, porque em ação agendada não existe tela
para exibir `mensagem`.

### O dedup em dois estágios

| Estágio | Critério | Quando | Por quê |
|---|---|---|---|
| 1 | `NOMEARQUIVO` | antes do download | Barato. Evita baixar XML já conhecido |
| 2 | `CHAVEACESSO` | depois do download | Pega notas antigas (formato de nome anterior), DF-e e importações manuais |

O estágio 2 é indispensável: as ~133 notas do histórico usam o formato antigo
`INVOICE-{idOrder}.XML` e **não** são reconhecidas pelo dedup por nome.

### Por que não é preciso consultar a `TGFCAB`

Verificado em 27/08/2026:

```sql
SELECT COUNT(*) FROM TGFCAB C
WHERE C.CODTIPOPER IN (1234, 1766) AND C.CHAVENFE IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM TGFIXN X WHERE X.CHAVEACESSO = C.CHAVENFE);
-- resultado: 0
```

Nota do Full **sempre** chega como XML, e XML **sempre** entra pela `TGFIXN`. Nota criada
internamente entra por insert direto na `TGFCAB`, mas o Full nunca é faturado aqui.
Paulo, 27/08: *"só a IXN, e o resto o motor faz."*

A `TGFIXN` é, portanto, o universo completo dessas notas.

### Identidade dos documentos

O identificador universal é o **nome do arquivo na URL do S3**:

```
https://s3.../transactionType-devolution/259061706.6606158899.xml
                                          └──────────┬─────────┘
                                            identificador
```

`NOMEARQUIVO` final: `INVOICE-devolution-259061706.6606158899.XML`

**Por que esse e não outro:** a API retorna apenas `id`, `url`, `marketplace`, `type` e
`subType` por documento — e nem todos existem em todos os tipos. O `id` está **ausente**
nos `sale`; o `idOrder` (usado numa versão anterior) está **ausente** nos
`symbolic_inbound_return`. Sonda de 27/08 varreu a conta inteira: o identificador da URL é
único em **100% dos documentos**, sem repetições e sem vazios.

O `type` foi incluído no nome porque a coluna é `VARCHAR2(200)` e o espaço é gratuito —
permite contar documentos por tipo na `TGFIXN` sem abrir XML nenhum.

---

## 3. Instalação

### Pré-requisitos

- Acesso ao Sankhya com permissão para editar ações de tela.
- Token da API da Anymarket (`gumgaToken`) válido.
- Tela `AD_TESTENOTA` publicada (gatilho de teste e destino do log).

### Passos

1. **Criar o parâmetro do sistema** com o token:
   - Nome: `ANYMARKET_TOKEN`
   - Valor: o token da Anymarket
   - ⚠️ Nunca versionar, colar em chat ou deixar em log.

2. **Testar** com `robo_full_teste_simulacao.js` — ver [seção 5](#5-como-testar-antes-de-agendar).

3. **Subir** `robo_full_tgfixn_lote.js` em Ações Agendadas — ver [seção 6](#6-agendamento).

---

## 4. Configuração

| Variável | Padrão | O que faz |
|---|---|---|
| `PARAM_TOKEN` | `"ANYMARKET_TOKEN"` | Nome do parâmetro do sistema com o token |
| `TOKEN_FALLBACK` | `""` | Token direto no código. **Só teste — vazio em produção** |
| `CODEMP_FIXO` | `1` | Empresa. Único CNPJ emitente no Full |
| `CODUSU_IMP` | `0` | Usuário de importação. Irrelevante — qualquer valor processa |
| `LIMITE_LOTE` | `40` | Notas gravadas por rodada. Evita timeout |
| `FILA_FOLGA` | `4` | Multiplicador da fila de candidatas |
| `MAX_PAGINAS` | `30` | Páginas de listagem varridas por rodada |
| `PAGE_SIZE` | `50` | Itens por página. **Mínimo aceito pela API é 5** |
| `TIPOS` | 2 ativos | Tipos de documento habilitados |

### Só na versão de teste

| Variável | Padrão | O que faz |
|---|---|---|
| `GRAVAR_TGFIXN` | `false` | `true` grava de verdade na `TGFIXN` |
| `GRAVAR_LOG` | `true` | Uma linha de relatório por documento na `AD_TESTENOTA` |
| `CONSIDERA_LOG` | `true` | Conta o que já foi simulado como "já visto" |

⚠️ **Sobre o `CONSIDERA_LOG`:** é um paliativo, porque não é possível rodar `DELETE` na
`AD_TESTENOTA` nesta instalação. Com ele ligado, a segunda rodada não repete as mesmas
notas — o que é útil, mas confunde: **um resultado vazio significa que tudo já foi
simulado, não que o script parou de funcionar.** Para repetir a simulação nas mesmas
notas, mude para `false`.

### Dimensionando o lote

`LIMITE_LOTE = 40` de hora em hora dá ~960 notas/dia — folgado para o volume atual.
Se o agendamento estourar timeout, reduza para 20 e aumente a frequência.

---

## 5. Como testar antes de agendar

**Não suba direto para agendamento.**

### Passo 1 — Simulação

Cole `robo_full_teste_simulacao.js` na ação "Verificar Parceiro" da `AD_TESTENOTA`
(o botão ⚡), com `GRAVAR_TGFIXN = false` e `LIMITE_LOTE = 5`.

### Passo 2 — Interpretando o resumo

| Campo | Significado |
|---|---|
| `nomes` / `chaves` | Tamanho dos conjuntos carregados da `TGFIXN` |
| `+sim` | Chaves vindas do log de simulações anteriores |
| `VARREU` | Documentos percorridos na listagem |
| `outrostipos` | Descartados pelo filtro `TIPOS` |
| `pulouNOME` | Descartados no dedup estágio 1 |
| `fila` | Candidatas coletadas |
| `pulouCHAVE` | Descartados no dedup estágio 2 |
| `NOVAS` | Documentos realmente novos |
| `motorCriara` | Parceiros que o motor vai cadastrar |
| `falhas` | Erros isolados. Idealmente 0 |

### Passo 3 — Conferir a grade da `AD_TESTENOTA`

Cada linha é um documento que *seria* importado. Checar:

- **`DOCPARC`** deve ser o documento da contraparte, **nunca** `28414558000132` (a BeBaby).
  Se aparecer o CNPJ da BeBaby ali, a lógica de escolher o lado oposto falhou.
- **`STATUS`** traz o resumo dos campos derivados: `E0 3/42670 R$149 C1202 Devolucao... refS 2026-08-07`
- **`PARCEXISTE`** é informativo, **não** é alerta — ver [seção 11](#11-decisões-de-projeto).

### Passo 4 — Conferir na `TGFIXN`

```sql
SELECT * FROM (
  SELECT NUARQUIVO, NOMEARQUIVO, CHAVEACESSO, STATUS, TIPONFE, ENTSAINFE,
         NUMNOTA, SERIEDOC, VLRNOTA, XNOMEDEST, CNPJPARC, CODTIPOPER, DHIMPORT
  FROM TGFIXN
  WHERE NOMEARQUIVO LIKE 'INVOICE-%'
  ORDER BY NUARQUIVO DESC
) WHERE ROWNUM <= 10;
```

Esperado: `TIPONFE` = `E` nas devoluções, `ENTSAINFE` = `0`, `NUMNOTA` e `SERIEDOC`
preenchidos, `CNPJPARC` com o documento da contraparte, **`CODTIPOPER` vazio** (o motor
preenche).

### Passo 5 — Rodar de novo

Com `CONSIDERA_LOG = true`, a segunda execução deve dar `NOVAS = 0` e `pulouCHAVE` maior.
**Se gravar duplicado, pare e investigue o dedup antes de seguir.**

### Passo 6 — Só então

Subir `robo_full_tgfixn_lote.js` em Ações Agendadas.

---

## 6. Agendamento

O script de produção foi escrito para funcionar sem sessão de usuário:

| Diferença em ação agendada | Como o script lida |
|---|---|
| Não existe `linhas[0]` nem linha selecionada | Não usa nenhum dos dois |
| `mensagem =` pode não aparecer em lugar nenhum | Grava log na `AD_TESTENOTA` |
| `throw` derruba o agendamento com rollback | `try/catch` por nota; `throw` só em erro fatal de configuração |
| Sem usuário logado | Token vem de `getParametroSistema` |

### Frequência sugerida

De hora em hora, ou a cada 30 minutos. As notas do Full não são urgentes ao minuto, e
frequência menor reduz o custo de varredura.

### Checklist antes de ligar

- [ ] Parâmetro `ANYMARKET_TOKEN` criado e válido
- [ ] `TOKEN_FALLBACK` vazio
- [ ] Simulação rodada com sucesso (seção 5)
- [ ] Segunda execução não duplicou
- [ ] Motor de importação processando (ver [seção 12](#12-pendências-abertas))

---

## 7. Operação e monitoramento

### Últimas rodadas do robô

```sql
SELECT * FROM (
  SELECT CODNOTA, TIPONOTA, STATUS, NOMEPARC, DTIMPORT
  FROM AD_TESTENOTA
  WHERE TIPONOTA IN ('ROBO LOTE', 'DIAG PARCEIRO')
  ORDER BY CODNOTA DESC
) WHERE ROWNUM <= 20;
```

`STATUS` guarda o resumo; `NOMEPARC` guarda os erros (ou `"sem erros"`).

### O que está travado sem processar

```sql
SELECT NUARQUIVO, NOMEARQUIVO, STATUS, DHIMPORT, DHPROCESS, DETALHESIMPORTACAO
FROM TGFIXN
WHERE NOMEARQUIVO LIKE 'INVOICE-%' AND STATUS = 0
ORDER BY DHIMPORT DESC;
```

`DETALHESIMPORTACAO` é a fonte de verdade quando o motor recusa uma nota.

### Contar por tipo

```sql
SELECT SUBSTR(NOMEARQUIVO, 9, INSTR(NOMEARQUIVO, '-', 9) - 9) AS TIPO,
       STATUS, COUNT(*) AS QTD
FROM TGFIXN
WHERE NOMEARQUIVO LIKE 'INVOICE-%-%'
GROUP BY SUBSTR(NOMEARQUIVO, 9, INSTR(NOMEARQUIVO, '-', 9) - 9), STATUS
ORDER BY TIPO, STATUS;
```

---

## 8. Habilitando novos tipos de documento

Descomente a linha correspondente em `TIPOS`.

### Diagnóstico de 27/08/2026 (98 documentos analisados)

| Tipo | Total | Amostra | Parceiro faltando | Contraparte | Status |
|---|---|---|---|---|---|
| `devolution` | 17 | 17 | 14 | CPF | ✅ ativo |
| `sale_return` | 7 | 7 | 6 | CPF | ✅ ativo |
| `inbound` | 13 | 13 | **0** | CNPJ | ⚪ liberado |
| `inbound_return` | 11 | 11 | **0** | CNPJ | ⚪ liberado |
| `symbolic_inbound` | 32 | 25 | **0** | CNPJ | ⚪ liberado |
| `symbolic_inbound_return` | 522 | 25 | **0** | CNPJ | ⚪ liberado |
| `sale` | 476 | — | — | — | 🔴 exige aval |

Total de documentos na conta: **1078**.

**Leitura:** os 20% globais de parceiro faltante são enganosos — o problema está 100%
concentrado nos dois tipos de consumidor final, e nem é problema (o motor cadastra).
Os quatro tipos de entrada e simbólicos têm contraparte CNPJ e **todos** já cadastrados.

### Ordem recomendada

1. **Não habilite nada** antes de ver uma nota sair de `STATUS 0` para `5`. Ligar tudo
   antes disso é gravar centenas de linhas que podem estar todas erradas do mesmo jeito.
2. Depois de validado, habilite os quatro tipos liberados, um por vez, com `LIMITE_LOTE`
   baixo, conferindo a nota gerada.
3. **`sale` por último.** Ver abaixo.

### Sobre as vendas (`sale`)

São 476 documentos, o maior grupo depois dos simbólicos, e o único com risco fiscal real.

O dedup **protege** contra reimportar uma venda que já passou pela `TGFIXN`. O que ele
**não** protege é o cenário inverso: se o robô importar uma venda e alguém faturar a mesma
coisa internamente depois, a duplicidade nasce do lado da emissão.

Pelo fluxo descrito por Dan e confirmado pelo Paulo, o Full **nunca** é faturado
internamente — então o cenário é teórico. Mas antes de ligar, vale confirmar com a
**Denise** que isso é regra formal, e não só prática observada.

---

## 9. Solução de problemas

### `Token da Anymarket nao configurado`

O parâmetro `ANYMARKET_TOKEN` não existe ou está vazio. Crie-o, ou preencha
`TOKEN_FALLBACK` temporariamente para testar.

### `HTTP 400: O limite mínimo permitido por página é de 5 recursos`

`PAGE_SIZE` menor que 5. A API não aceita.

### `HTTP 401` ou `HTTP 403`

Token inválido ou expirado. Um token já foi exposto anteriormente e deve estar
rotacionado — confirme que o parâmetro tem o valor atual.

### `Tipo esperado 'String', tipo recebido 'java.math.BigDecimal'`

Um `setCampo` está mandando número onde a coluna é texto. **O valor exibido num export
não revela o tipo** — `CFOPXML` mostra `1202` e é `VARCHAR2`; `ENTSAINFE` mostra `0` e é
`VARCHAR2(1)`.

```sql
SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH
FROM USER_TAB_COLUMNS
WHERE TABLE_NAME = 'TGFIXN' AND COLUMN_NAME = 'NOME_DO_CAMPO';
```

Regra: `VARCHAR2`/`CHAR`/`CLOB` → `String(x)` · `NUMBER`/`FLOAT` → `Number(x)` ·
`DATE` → objeto `Date`

### `Propriedade 'X' com largura acima do limite: (126 > 100)`

O Sankhya valida **largura** além de tipo, e a mensagem dá o número exato. Ajuste o
`corta()` do campo. Larguras já conhecidas: `AD_TESTENOTA.STATUS` = 100,
`TGFIXN.NOMEARQUIVO` = 200, `TGFIXN.XNOMEEMIT`/`XNOMEDEST` = 60,
`TGFIXN.CNPJPARC`/`CNPJDEST` = 14.

### `unterminated string literal`

Aspa curva vinda de copiar/colar, ou `\n` dentro de string. Use aspas retas.

### A simulação não traz mais nada

Comportamento esperado com `CONSIDERA_LOG = true`: tudo já foi simulado. Confira o
`pulouCHAVE` no resumo. Para repetir, mude para `false`.

### Notas ficam em `STATUS = 0` para sempre

**O motor não está processando.** Verifique se as notas que o **próprio Paulo** subiu pela
importação interna também estão em `STATUS 0` — se sim, o problema não é do robô.

Bloqueio conhecido em homologação: tabela `TGFLOCOPER` inexistente e metadados de
`TGFTOP->NFSETIPOPER` não inicializados. Causa provável: base clonada com versão de
aplicação dessincronizada. **É infra, não código.**

### Erro `CNPJ não encontrado` no `DETALHESIMPORTACAO`

Não deveria acontecer no caso normal: o motor **cadastra** o parceiro na `TGFPAR` quando
não existe (Paulo, 27/08). Se aparecer, é caso específico — XML sem bloco de documento,
CPF/CNPJ inválido, ou algo que impeça o cadastro. Pré-checagem manual:

```sql
SELECT CODPARC, NOMEPARC FROM TGFPAR
WHERE CGC_CPF IS NOT NULL
  AND REGEXP_REPLACE(CGC_CPF, '[^0-9]', '') = '{documento_so_digitos}'
```

`CGC_CPF` é armazenado só com dígitos. O `IS NOT NULL` é obrigatório: sem ele, parceiros
sem documento vazam no resultado (string vazia = NULL no Oracle).

---

## 10. Limitações conhecidas

### Não existe filtro por data

**A API da Anymarket não retorna data na listagem.** Os únicos campos por documento são
`id`, `url`, `marketplace`, `type` e `subType`. O parâmetro `createdAfter` é aceito e
repassado no link de paginação, mas **não filtra nada** — testado em 27/08/2026 (o
primeiro item retornado é idêntico com e sem o filtro).

A data só existe dentro do XML (`dhEmi`), então filtrar por período exigiria baixar todos
os ~1000 XMLs para descartar a maioria. Inviável.

**Consequência:** o requisito original "importar os últimos 30 dias" não é implementável.
O dedup entrega o efeito prático desejado de forma melhor: pega o que falta de **qualquer**
época, inclusive documentos retroativos que uma janela de 30 dias perderia.

### A listagem é do mais antigo para o mais novo

Offset 0 é o documento mais antigo da conta (confirmado: ids crescentes ao longo da
paginação). Não dá para parar cedo na varredura — é preciso percorrer para achar os novos.
É o que torna o dedup em memória essencial: percorrer é barato, baixar não.

### A regra do `CNPJPARC` não foi validada empiricamente

O script escolhe "o lado que não é a BeBaby", extraindo o CNPJ dela das posições 7–20 da
chave de acesso. Nos 98 documentos diagnosticados, a BeBaby era **sempre** a emitente —
inclusive nos tipos de entrada. O ramo que escolheria o emitente **nunca executou**.

A lógica é mais segura que fixar no destinatário, mas continua sem prova de campo.

### `CFOPXML` usa o CFOP do primeiro item

Se uma nota tiver itens com CFOPs diferentes, não se sabe qual o Portal escolheria. Sem
impacto conhecido, já que a TOP é deduzida pelo motor.

### `CODEMP` fixo em 1

Débito técnico **consciente**, não desconhecimento: existe um único CNPJ emitente
(`28414558000132`) em todas as 121 notas do histórico do Full, sempre com `CODEMP = 1`.
Se a BeBaby passar a operar o Full por outra empresa, isso precisa virar regra por CNPJ.

### Não é possível rodar `DELETE` nesta instalação

Afeta a limpeza da `AD_TESTENOTA` (log de simulações) e das linhas de teste antigas na
`TGFIXN`. Vale confirmar com o Paulo se é falta de permissão ou se o DBExplorer é
somente-leitura.

---

## 11. Decisões de projeto

Registro do "por quê" de cada escolha não óbvia.

### `CODTIPOPER` não é enviado

Paulo, 27/08: *"Não precisa enviar, porque pode ser mais de uma. Ela pega pelo modelo do
que está no XML — se for dev, venda ou remessa."*

Confirmado pelos dados: a TOP `1766` cobre 2 naturezas × 2 CFOPs (1202 dentro do estado,
2202 fora). Não há mapeamento 1:1 possível. **Enviar limitaria a dedução do motor.**

Efeito colateral positivo: expandir para novos tipos não exige mapeamento de TOP nenhum.

### `TIPONFE` é derivado do `tpNF` — e há um conflito aberto

⚠️ **Paulo disse:** D = Devolução, E = Remessa, V = Venda.
⚠️ **Os dados dizem:** não existe **nenhuma** nota com `'D'` em 121 notas processadas.

Correlação perfeita nas notas em `STATUS 5`:

| `ENTSAINFE` | `TIPONFE` | Qtd |
|---|---|---|
| 1 (saída) | `V` | 93 vendas |
| 0 (entrada) | `E` | 27 devoluções / retornos |

**Decisão adotada:** o campo espelha o `tpNF` do XML (entrada/saída), não a natureza da
operação. Isso também explica o `'E'` na importação interna do Paulo — não foi descuido,
foi o comportamento correto.

Se ele confirmar um caso em que `'D'` é usado, a função `tipoNfeDe()` é o **único** ponto
a alterar.

### O motor cadastra o parceiro — `PARCEXISTE` é informativo

Paulo, 27/08: o motor **cadastra** os parceiros na `TGFPAR` quando não existem.

Isso reinterpreta a fala anterior dele (*"usa o CNPJ, por isso às vezes dá erro de CNPJ
não encontrado"*): o erro é exceção, não regra. Ele cria a partir dos blocos `<emit>`/
`<dest>` do XML.

Consequência: a coluna `PARCEXISTE` da simulação **não é alerta**. Um `N` apenas prevê que
aquele parceiro será criado no processamento. Serve para saber o que esperar na `TGFPAR`
depois de uma rodada.

### `CONFIG` e `CODPARC` não são preenchidos

São saída do motor, não entrada. Confirmado por dado: `CONFIG` preenchida em 100% das
notas em `STATUS 5` e vazia em 100% das em `STATUS 0`. `CODPARC` idem.

### O prefixo `INVOICE-` foi mantido

O identificador mudou (de `idOrder` para o nome de arquivo da URL), mas o prefixo não.
Preserva as queries de investigação que usam `LIKE 'INVOICE-%'` e a convenção da Tem Api.

### O `getErrorStream()` no `baixa()`

Quando o HTTP não é 2xx, `getInputStream()` estoura antes de ler o corpo — e a mensagem
de erro da API se perde. Foi assim que o limite mínimo de 5 itens por página ficou
invisível por uma rodada inteira. Ler o `getErrorStream()` transforma "deu erro" em "deu
erro porque X".

### Log agregado em produção, detalhado em teste

A versão de produção grava **uma** linha por rodada. A de teste grava **uma por
documento**, porque na simulação o valor está no detalhe. Como não é possível dar `DELETE`,
o log detalhado em produção encheria a tabela sem utilidade.

---

## 12. Pendências abertas

| # | Pendência | Com quem | Bloqueia? |
|---|---|---|---|
| 1 | **Motor não processa.** Notas em `STATUS 0`, incluindo as do próprio Paulo (112628–112630). `TGFLOCOPER` / `NFSETIPOPER` | Paulo | **Sim** — é o único bloqueio real |
| 2 | `TIPONFE`: confirmar `'E'` vs `'D'` (seção 11) | Paulo | Não — dado embasa a escolha |
| 3 | Em que situação ocorre o "CNPJ não encontrado", se o motor cadastra? | Paulo | Não — mas define o que monitorar |
| 4 | `NOMEARQUIVO` é apenas rótulo? Nada no motor depende do formato? | Paulo | Não |
| 5 | Ação "Importar por Local" reconfigura o catálogo inteiro e está sem controle de acesso | Paulo | Não — mas é risco operacional |
| 6 | O Full é *sempre* importado e *nunca* faturado internamente — é regra formal? | Denise | Só para habilitar `sale` |
| 7 | Permissão de `DELETE` no DBExplorer | Paulo | Não |

### O caminho crítico

Só o item 1. Enquanto o motor não processar, não é possível validar que a nota nasce
correta — e sem isso não se habilita tipo novo. Todo o resto do robô está pronto.

---

## Referência: a chave de acesso da NF-e

44 dígitos. Posições em base 1 (SQL) — em JavaScript, subtraia 1.

| Posições | Conteúdo | Uso |
|---|---|---|
| 1–2 | cUF (UF do emitente) | — |
| 3–6 | AAMM da emissão | — |
| 7–20 | **CNPJ do emitente** | identificar a BeBaby → `CNPJPARC` |
| 21–22 | modelo (55 = NF-e) | — |
| 23–25 | **série** | → `SERIEDOC` |
| 26–34 | **número da nota** | → `NUMNOTA` |
| 35 | tipo de emissão | — |
| 36–43 | código numérico | — |
| 44 | dígito verificador | — |

Em JavaScript: `ch.substring(6,20)` = CNPJ, `ch.substring(22,25)` = série,
`ch.substring(25,34)` = número.

---

## Contatos

| Pessoa | Papel | Assuntos |
|---|---|---|
| **Paulo Vieira** | Dev terceirizado Sankhya | Motor de importação, TOPs, estrutura fiscal, infra da homologação |
| **Denise** | Operações | Aval sobre importação de notas de venda |
