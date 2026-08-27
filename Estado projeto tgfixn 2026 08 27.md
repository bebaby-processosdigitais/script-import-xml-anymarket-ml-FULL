# Estado do Projeto: Robô de Importação Full (Anymarket → Sankhya TGFIXN)

> **Propósito:** handoff de contexto. Substitui a versão de 21/08/2026.
> **Última atualização:** 27/08/2026
> **Mudança principal desde a versão anterior:** todas as dúvidas de preenchimento de
> campo foram fechadas — parte por resposta do Paulo, parte por engenharia reversa em
> 121 notas processadas. O script tem paridade de campos com a importação interna.

---

## 1. O que mudou nesta rodada (resumo executivo)

| Antes (21/08) | Agora (27/08) |
|---|---|
| 6 campos em dúvida | 0 campos em dúvida |
| `CODTIPOPER` enviado como 1766 | **Não se envia** — o motor deduz |
| `TIPONFE` desconhecido | Derivado do `tpNF` do XML |
| 7 campos preenchidos | 20 campos preenchidos |
| "o motor cria o parceiro" | **Falso** — ele só localiza; falha se não achar |
| Expandir p/ outros tipos = projeto | Expandir = remover um filtro |

---

## 2. Contexto do negócio (inalterado)

- **Empresa:** BeBaby Group Importação Ltda. (marcas Kikkaboo e ABC Design).
- **ERP:** Sankhya, Oracle como SGBD.
- **Objetivo:** reduzir dependência da integração terceirizada **Tem Api**, reconstruindo
  de forma independente a importação das notas do Mercado Livre Full.
- **Origem do problema:** a Tem Api parou de trazer as notas do Full em **29/06/2026**
  (última `INVOICE-` em 29/06/2026 10:59 — reconfirmado nesta rodada).
- **Fonte de dados:** API da **Anymarket** (token disponível).
- **Pessoas:** Dan (desenvolvimento), **Paulo Vieira** (dev terceirizado Sankhya,
  autoridade sobre o motor e a estrutura fiscal), **Denise** (operações).

---

## 3. Arquitetura (confirmada)

```
Anymarket API → baixa XML (S3) → grava na TGFIXN (STATUS 0) → motor Java processa
```

O motor de importação faz a transformação em nota fiscal usando as "regras do Full"
que o Paulo configurou. O robô **não** monta a nota, **não** define a TOP e **não**
cadastra parceiro.

### Onde vive o motor (investigação encerrada)

Pergunta: "dá pra ler o script que importa o XML?" **Resposta: não existe como código
legível no banco.**

- `USER_TRIGGERS` da `TGFIXN` → **vazio**.
- `USER_SOURCE` mencionando `TGFIXN` → só `TRG_INC_TGFCAB`, `TRG_UPD_TGFCAB`,
  `TRG_DLT_TGFCAB`, `STP_GERAR_LIVRO_FIN` — todas são a **fiação de saída** (quando a
  nota nasce na `TGFCAB`, elas voltam e atualizam a `TGFIXN`).
- Por eliminação: é **Java**, dentro do .jar do servidor. A instância se chama
  `ImportacaoXMLNotas` (nome que aparece nos erros da homologação).
- Ler exigiria descompilar o jar — depende de infra e esbarra em licença. **Descartado.**

### A ação "Importar por Local" NÃO é o motor (provado)

No Construtor de Telas, a instância `ImportacaoXMLNotas` tem uma ação tipo *Rotina no
Banco de Dados* chamada "Importar por Local", que aponta para `STP_ALTERALOCALPADRAO_ABC`.
Código lido:

```sql
UPDATE TGFPRO SET CODLOCALPADRAO = PARAM_LOCAL
WHERE ATIVO = 'S' AND USALOCAL = 'S';
```

⚠️ **ALERTA OPERACIONAL:** essa ação **não tem nada a ver com importar nota**. Ela troca
o local padrão de **todos os produtos ativos da base**, dá `COMMIT` sozinha, e **ignora**
o parâmetro `P_QTDLINHAS` (não importa quantas linhas o usuário selecionou). O
`Controla Acesso` dela está **desligado**. Se alguém da operação clicar achando que está
direcionando uma nota, reconfigura o estoque padrão do catálogo inteiro.
**→ Levar ao Paulo: ligar controle de acesso ou renomear.**

### Contrato de ação "Rotina no Banco de Dados" nesta base

Útil se algum dia o robô virar PL/SQL em vez de script JS:

| Parâmetro | Papel |
|---|---|
| `P_CODUSU` | usuário logado |
| `P_IDSESSAO` | chave da sessão (é por ela que se lê parâmetros) |
| `P_QTDLINHAS` | linhas selecionadas na tela |
| `P_MENSAGEM OUT` | texto devolvido para a tela |

Leitura de parâmetro: `ACT_INT_PARAM(P_IDSESSAO, 'NOME')` para numéricos.
Descobrir as irmãs: `SELECT DISTINCT NAME FROM USER_SOURCE WHERE NAME LIKE 'ACT_%_PARAM';`

---

## 4. O que o script faz HOJE (estado exato)

Arquivo: `robo_devolucao_full_tgfixn.js`
Onde roda: ação Script **"Verificar Parceiro"** da tela `AD_TESTENOTA` (usada só como
gatilho — o script grava na `TGFIXN`, não na `AD_TESTENOTA`).

### Fluxo

1. Varre a API da Anymarket paginando de 50 em 50, até `MAX_PAGINAS = 30`.
2. Filtra apenas `type === "devolution"` ou `type === "sale_return"`.
3. Baixa o XML do S3 (link público, **sem** o gumgaToken).
4. Extrai a `chNFe` e checa duplicidade: `SELECT COUNT(*) FROM TGFIXN WHERE CHAVEACESSO = ...`
5. Para na **primeira** devolução nova encontrada.
6. Extrai os dados do XML e grava **uma** linha na `TGFIXN` com `STATUS = 0`.
7. Devolve resumo via `mensagem =`.

### ⚠️ Limitações conhecidas do estado atual

| Limitação | Detalhe |
|---|---|
| **Uma nota por execução** | O laço dá `break` na primeira nova. 17 devoluções = 17 cliques. |
| **Só 2 dos 7 tipos** | Cobre ~17 de ~1000 documentos (**menos de 2%**). |
| **`CNPJPARC` fixo no destinatário** | Correto para venda/devolução; **quebra** nos tipos `inbound`, onde a BeBaby é a destinatária. |
| **Token hardcoded** | Deveria vir de `getParametroSistema`. |
| **Ação de botão** | Não é robô agendado; sujeito a timeout de tela. |

---

## 5. Campos da TGFIXN — tabela definitiva

### Preenchidos pelo script (20)

| Campo | Tipo | Valor / Origem | Fonte da decisão |
|---|---|---|---|
| `XML` | CLOB | XML inteiro | Anymarket |
| `CHAVEACESSO` | VARCHAR2 | `<chNFe>` | XML |
| `NOMEARQUIVO` | VARCHAR2 | `INVOICE-{idOrder}.XML` | eng. reversa (padrão Tem Api) |
| `TIPO` | — | `'N'` | Paulo |
| `STATUS` | — | `0` | Paulo |
| `CODEMP` | NUMBER | `1` | Paulo + dado (só 1 CNPJ no Full) |
| `DHIMPORT` | DATE | `new Date()` | Paulo |
| `CODUSUIMP` | NUMBER | `0` | dado (qualquer valor serve) |
| `TIPONFE` | CHAR(1) | derivado do `tpNF` | **dado (121 notas)** |
| `NUMNOTA` | NUMBER | chave, pos. 26–34 | XML derivado |
| `SERIEDOC` | NUMBER | chave, pos. 23–25 | XML derivado |
| `NATUREZAOPER` | VARCHAR2 | `<natOp>` | XML |
| `CFOPXML` | VARCHAR2 | `<CFOP>` (1º item) | XML |
| `ENTSAINFE` | VARCHAR2(1) | `<tpNF>` **como String** | XML |
| `VLRNOTA` | FLOAT | `<vNF>` | XML |
| `DHEMISS` | DATE | `<dhEmi>` convertido | XML |
| `DTAUTORIZACAO` | DATE | `<dhRecbto>` do protNFe | XML |
| `XNOMEEMIT` | VARCHAR2(60) | `<emit><xNome>`, cortado | XML |
| `XNOMEDEST` | VARCHAR2(60) | `<dest><xNome>`, cortado | XML |
| `CNPJDEST` / `CNPJPARC` | VARCHAR2(14) | `<dest>` CNPJ ou CPF | XML + dado |
| `DOCSREF` | CLOB | `<docsRef><chaveAcesso>{refNFe}</chaveAcesso></docsRef>` | **dado (formato confirmado)** |

### Deliberadamente NÃO preenchidos

| Campo | Motivo |
|---|---|
| `NUARQUIVO` | PK autonumerada |
| `CODTIPOPER` | **O motor deduz pelo modelo do XML** (Paulo, 27/08) |
| `CODPARC` | Saída do motor (vazio em STATUS 0, preenchido em STATUS 5) |
| `CONFIG` | Log de validação gerado pelo motor (`TEM_CONFIG` = S só nas STATUS 5) |
| `NUNOTA`, `DHPROCESS`, `CODUSUPROC`, `DETALHESIMPORTACAO`, `STATUSZIP`, `IDPROCESSO` | Saída do processamento |

### Tipos — armadilha importante

**O Sankhya valida tipo pelos metadados da instância, e o valor exibido num export NÃO
revela o tipo.** `CFOPXML` mostra `1202` e é VARCHAR2. `ENTSAINFE` mostra `0` e é
VARCHAR2(1). Erro típico:

```
'ImportacaoXMLNotas->ENTSAINFE': Tipo esperado 'String', tipo recebido 'java.math.BigDecimal'.
```

Regra: `VARCHAR2`/`CHAR`/`CLOB` → `String(x)` · `NUMBER`/`FLOAT` → `Number(x)` · `DATE` → objeto `Date`

Tipos confirmados: `CFOPXML` VARCHAR2(2000) · `CNPJDEST`/`CNPJPARC`/`CNPJEXPED`/`CNPJRECEB`/`CNPJREMET`/`CNPJTRANSP` VARCHAR2(14) · `CODTIPOPER`/`CODUSUIMP`/`NUMNOTA`/`SERIEDOC`/`CODPARCDEST` NUMBER · `DHEMISS`/`DTAUTORIZACAO` DATE · `DOCSREF` CLOB · `ENTSAINFE` VARCHAR2(1) · `TIPONFE` CHAR(1) · `VLRNOTA` FLOAT · `XNOMEDEST`/`XNOMEEMIT` VARCHAR2(60)

---

## 6. Respostas do Paulo (27/08/2026)

| Pergunta | Resposta |
|---|---|
| `CODTIPOPER` é obrigatório? | *"Não precisa enviar, porque pode ser mais de uma. Ela pega pelo modelo do que está no XML — se for dev, venda ou remessa."* |
| `TIPONFE` da devolução | *"Devolução é D, Remessa é E e Venda é V"* — ⚠️ **contradiz o dado, ver §7** |
| `CNPJPARC` localiza o parceiro? | *"Usa o CNPJ, por isso às vezes dá erro de CNPJ não encontrado"* |
| `CODEMP` | *"Pode fazer pelo CNPJ também, mas eu fixaria 1 no primeiro momento"* |
| `DOCSREF` | *"Sem problemas, pode manter, não impacta"* |
| `CONFIG` | *"É o motor que gera"* |

### 🔴 Correção de premissa importante

Antes assumíamos que **o motor cria o parceiro** se não existir. **É falso.** Ele apenas
**localiza pelo CNPJ/CPF** e falha com "CNPJ não encontrado". Esse é o erro mais provável
de aparecer em `DETALHESIMPORTACAO`.

Para devolução do Full o risco é baixo (o consumidor já foi cadastrado na venda original).
Ao expandir para outros tipos, cada um pode trazer parceiro inédito → vale pré-checar
antes de gravar.

Query de pré-checagem (blindada contra NULL — string vazia = NULL no Oracle):

```sql
SELECT CODPARC, NOMEPARC FROM TGFPAR
WHERE CGC_CPF IS NOT NULL
  AND REGEXP_REPLACE(CGC_CPF, '[^0-9]', '') = '{documento_so_digitos}'
```

Na base, `CGC_CPF` é armazenado **só com dígitos**.

---

## 7. ⚠️ Conflito aberto: `TIPONFE`

**Paulo disse:** D = Devolução, E = Remessa, V = Venda.
**Os dados dizem:** não existe **nenhuma** nota com `'D'` em 121 notas processadas.

Correlação perfeita, sem uma exceção, nas notas em STATUS 5:

| `ENTSAINFE` | `TIPONFE` | Qtd |
|---|---|---|
| 1 (saída) | `V` | 93 vendas |
| 0 (entrada) | `E` | 27 devoluções / retornos |

**Conclusão adotada:** o campo espelha o `tpNF` do XML (entrada/saída), não a natureza
da operação. O script deriva:

```javascript
function tipoNfeDe(tpNF) { return (String(tpNF) === "1") ? "V" : "E"; }
```

Isso também explica o `'E'` na importação interna do Paulo (112625): não foi descuido,
foi o comportamento correto.

**Pendente:** confrontar com o Paulo. Texto sugerido:
> "Você falou que devolução é D, mas rodei um levantamento nas notas que processaram
> (STATUS 5) e não achei nenhuma com D — as 27 devoluções TOP 1766 estão todas com E, e
> as 93 vendas com V. O E/V parece acompanhar o tpNF do XML. Deixei o script derivando
> assim. Faz sentido ou tem algum caso em que o D é usado?"

**Lição de método:** o gabarito da importação interna serviu para descobrir *quais* campos
preencher, mas **não** é confiável para descobrir *qual valor* colocar num campo que a
pessoa digita à mão na tela. Para valor, o gabarito é o histórico processado.

---

## 8. Mapa de produção — engenharia reversa em 121 notas (27/08)

Resultado do `GROUP BY` sobre todas as `NOMEARQUIVO LIKE 'INVOICE-%'`:

| CODTIPOPER | NATUREZAOPER | TIPONFE | ENTSAINFE | CFOPXML | CODEMP | STATUS | QTD | Período |
|---|---|---|---|---|---|---|---|---|
| 1234 | Venda de mercadorias | V | 1 | 5106 | 1 | 5 | 31 | 22/04 – 29/06 |
| 1234 | Venda de mercadorias | V | 1 | 6106 | 1 | 5 | 62 | 22/04 – 29/06 |
| 1766 | Devolucao de mercadorias | E | 0 | 1202 | 1 | 5 | 6 | 23/04 – 18/06 |
| 1766 | Devolucao de mercadorias | E | 0 | 2202 | 1 | 5 | 12 | 23/04 – 30/05 |
| 1766 | Retorno de mercadoria não entregue | E | 0 | 1202 | 1 | 5 | 1 | 22/05 |
| 1766 | Retorno de mercadoria não entregue | E | 0 | 2202 | 1 | 5 | 8 | 27/04 – 15/05 |

### Conclusões extraídas

- **`CODEMP` deixou de ser dúvida.** Existe **um único** `CNPJ_EMIT` em todas as 121 notas
  (`28414558000132`), sempre com `CODEMP = 1`. A observação anterior de "notas com CODEMP 2
  em produção" **não vale para o Full** — é outro canal. Fixar 1 está correto, e não é
  débito técnico.
- **A TOP não mapeia 1:1 com CFOP nem com natureza.** `1766` cobre 2 naturezas × 2 CFOPs
  (1202 dentro do estado, 2202 fora). Confirma na prática por que o Paulo disse para não
  enviar `CODTIPOPER`.
- **`CONFIG` é 100% do motor.** `TEM_CONFIG = S` em todas as STATUS 5, `N` em todas as
  STATUS 0, sem exceção.
- **`CODPARC` é saída do motor.** Preenchido nas processadas (ex.: 56811, 55500), vazio
  nas pendentes.
- **`CODUSUIMP` é irrelevante.** Tem Api usava `102`; importações manuais usaram `66` e
  `86`; todas processaram.
- **`DOCSREF` — formato confirmado literalmente** em 7 notas:
  `<docsRef><chaveAcesso>35260828414558000132550030000424551112515053</chaveAcesso></docsRef>`
- **Data da quebra reconfirmada:** última `INVOICE-` em **29/06/2026 10:59**.
- **`CNPJPARC` == `CNPJDEST` nas 121 notas** — inclusive nas vendas. **Mas isso não prova
  a regra:** em venda e devolução do Full a BeBaby é sempre a emitente, então o "outro
  lado" é sempre o destinatário. **Não existe no histórico nenhuma nota em que a BeBaby
  seja destinatária.** A regra a implementar é *"`CNPJPARC` = o CNPJ que não é o da
  BeBaby"*, não *"= destinatário"*.

---

## 9. A API da Anymarket

```
GET https://api.anymarket.com.br/v2/fulfillment/MERCADO_LIVRE/documents?limit=50&offset=0
Header: gumgaToken: {TOKEN}
```

Retorna `content` (lista) e `links` (com `rel:"next"` para paginação). Cada documento traz
`idOrder`, `url` (XML no S3), `marketplace`, `type`.

### Cobertura por tipo

| Tipo | Qtd | Entra hoje? | Observação |
|---|---|---|---|
| `symbolic_inbound_return` | 502 | ❌ | maior volume, provavelmente menos crítico |
| `sale` | 423 | ❌ | **risco fiscal — precisa aval** |
| `symbolic_inbound` | 28 | ❌ | |
| `inbound` | 19 | ❌ | entrada real, afeta estoque |
| `devolution` | 12 | ✅ | |
| `inbound_return` | 11 | ❌ | entrada real, afeta estoque |
| `sale_return` | 5 | ✅ | |

Cobertura atual: **~17 de ~1000 (menos de 2%)**.

As devoluções são raras e espalhadas — não estão na primeira página. Daí `MAX_PAGINAS = 30`.

### Download do XML

A `url` aponta para o S3 (link público). **Baixar SEM o gumgaToken** — mandar token pode
atrapalhar.

### 🔒 Segurança do token

O `gumgaToken` é credencial sensível. **Nunca colar em chat ou log.** Um token já foi
exposto e deve estar rotacionado. Em produção, ler de `getParametroSistema`, não hardcoded.

---

## 10. Convenções de script Sankhya desta instalação

- **Sucesso:** `mensagem = "texto";` → NÃO cancela a transação. Caixa amarela.
- **Erro / abortar:** `throw "texto";` → **CANCELA a transação** (rollback, desfaz `save()`
  anteriores). Caixa vermelha. **Nunca usar `throw` depois de gravar.**
- Ler campo: `linhas[0].getCampo('CAMPO')`
- Gravar: `linha.setCampo('CAMPO', valor)` + `linha.save()`
- Criar registro: `var nova = novaLinha('TABELA'); nova.setCampo(...); nova.save();`
- SELECT:
  ```javascript
  var q = getQuery("native");
  q.setParam("x", valor);
  q.nativeSelect("SELECT ... WHERE campo = {x}");   // placeholder é {x}, NÃO ?
  if (q.next()) { var v = q.getString("COLUNA"); }
  ```
- HTTP: `new java.net.URL(...)`, `openConnection()`, `setRequestProperty(...)`,
  ler com `new java.util.Scanner(stream, "UTF-8").useDelimiter("\\A")`
- Data atual: `new Date()`. Data construída: `new Date(ano, mes-1, dia, h, m, s)` funciona.
- Sondar objeto desconhecido: `for (var k in obj) { ... }`
- Métodos disponíveis no contexto: `contexto, linhas, linhaPai, getQuery, novaLinha,
  getUsuarioLogado, mensagem, mostraErro, getParam, confirmarSimNao, email`

### Erros comuns

- `unterminated string literal` → aspa curva vinda de copiar/colar, ou `\n` na string.
  Usar aspas retas, evitar `\n`.
- `X is not defined` → variável sem `var`. Declarar no topo.
- `Tipo esperado 'String', tipo recebido 'java.math.BigDecimal'` → ver §5, tabela de tipos.

---

## 11. Estado do ambiente / bloqueio

- ✅ Coleta funcionando (Anymarket → filtro → download → dedup).
- ✅ Gravação funcionando com paridade de campos (última linha boa: **112631**).
- ⛔ **O motor não processa.** Notas paradas em `STATUS = 0` com `DHPROCESS` vazio —
  inclusive as que o **próprio Paulo** subiu pela importação interna (112628, 112629,
  112630). Ou seja: **não é problema do nosso script.**
- Erros de estrutura da homologação reportados antes: tabela `TGFLOCOPER` inexistente e
  metadados de `TGFTOP->NFSETIPOPER` não inicializados. Causa provável: base clonada com
  versão de aplicação dessincronizada. **É infra, não código.** Paulo tratando.
- A última resposta dele (*"sobre a config é o motor que gera e a homolog também"*) é
  ambígua. O comportamento diz que não está rodando.
  **→ Perguntar: "a homologação já processa? As duas notas seguem em STATUS 0."**

Homologação é clone periódico da produção — isolada, gravar aqui **não** gera nota fiscal real.

### Linhas de teste na TGFIXN (homologação)

| NUARQUIVO | O que é |
|---|---|
| 112616, 112617, 112618 | testes antigos, campos incompletos |
| 112620 | linha fake `TESTE-DHIMPORT` (candidata a limpeza) |
| 112621, 112626 | testes intermediários |
| 112625, 112628, 112629, 112630 | **importações internas do Paulo** (gabarito) |
| 112631 | **script atual, paridade completa** |

---

## 12. Próximos passos

### Curto prazo (independem do motor)

1. **Converter para lote** — hoje é uma nota por clique. Precisa de `LIMITE` por rodada
   para não estourar timeout de ação de tela.
2. **Corrigir `CNPJPARC`** — trocar "= destinatário" por "= o CNPJ que não é o da BeBaby".
   Pré-requisito para qualquer expansão de tipo.
3. **Tirar o token do hardcode** → `getParametroSistema`.
4. Perguntar ao Paulo sobre o `TIPONFE` (§7) e sobre a homologação (§11).

### Quando o motor voltar

5. Observar uma nota processar (`STATUS 0 → 5`).
6. Se travar, ler `DETALHESIMPORTACAO` — o erro mais provável é "CNPJ não encontrado".
7. **Validar a nota gerada:** `CODTIPOPER` virou 1766? Parceiro certo? Valor bate?
   `NUNOTA` gerado? `CONFIG` preenchida?
8. Opcional: **Monitoramento de Banco de Dados** para ver os SQLs que o motor dispara —
   forma de entender o mecanismo sem acessar o Java.

### Expansão (ordem sugerida — por risco, não por curiosidade)

9. Fechar as 17 devoluções primeiro.
10. Expandir para os tipos de entrada (`inbound`, `inbound_return`, simbólicos).
    Só depois do passo 2.
11. **Vendas por último.** 423 documentos e é o único grupo com risco fiscal real.
    **Pergunta em aberto para Paulo E Denise:** as notas de venda já entram por outro
    caminho (DF-e, emissão própria, Tem Api parcial)? Importar venda em duplicidade não
    é erro de teste, é problema fiscal.
12. Migrar de ação de botão para **robô agendado** (job / API Gateway). Só aí substitui
    de fato a Tem Api.

---

## 13. Queries de investigação

### Estrutura e metadados

```sql
-- Estrutura de uma tabela
SELECT COLUMN_ID, COLUMN_NAME, DATA_TYPE, DATA_LENGTH, NULLABLE
FROM USER_TAB_COLUMNS WHERE TABLE_NAME = 'TGFIXN' ORDER BY COLUMN_ID;

-- Tipos de campos específicos (ANTES de escrever setCampo)
SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH
FROM USER_TAB_COLUMNS
WHERE TABLE_NAME = 'TGFIXN'
  AND COLUMN_NAME IN ('ENTSAINFE','NUMNOTA','SERIEDOC','CODTIPOPER','CFOPXML',
                      'VLRNOTA','DHEMISS','DTAUTORIZACAO','DOCSREF','CODUSUIMP',
                      'XNOMEEMIT','XNOMEDEST','CNPJPARC','CNPJDEST','TIPONFE')
ORDER BY COLUMN_NAME;

-- Default de coluna
SELECT COLUMN_NAME, DATA_DEFAULT FROM USER_TAB_COLUMNS
WHERE TABLE_NAME = 'TGFIXN' AND COLUMN_NAME IN ('TIPONFE','TOMADORCTE','STATUS');

-- PK de uma tabela
SELECT cols.COLUMN_NAME, cols.POSITION
FROM USER_CONSTRAINTS cons
JOIN USER_CONS_COLUMNS cols ON cons.CONSTRAINT_NAME = cols.CONSTRAINT_NAME
WHERE cons.TABLE_NAME = 'TGFIXN' AND cons.CONSTRAINT_TYPE = 'P'
ORDER BY cols.POSITION;

-- Achar tabelas por assunto
SELECT TABLE_NAME FROM USER_TABLES
WHERE TABLE_NAME LIKE '%XML%' OR TABLE_NAME LIKE '%NFE%' OR TABLE_NAME LIKE '%DFE%'
ORDER BY TABLE_NAME;

-- Ler código PL/SQL
SELECT TEXT FROM USER_SOURCE WHERE NAME = 'STP_ALTERALOCALPADRAO_ABC' ORDER BY LINE;

-- Triggers de uma tabela
SELECT TRIGGER_NAME, TRIGGERING_EVENT, STATUS FROM USER_TRIGGERS
WHERE TABLE_NAME = 'TGFIXN';
```

### O mapa — engenharia reversa em massa (a query mais valiosa)

Truque: `SUBSTR(CHAVEACESSO, 7, 14)` extrai o CNPJ do emitente direto da chave, sem
depender de coluna nenhuma.

```sql
SELECT CODTIPOPER, NATUREZAOPER, TIPONFE, ENTSAINFE, CFOPXML, TIPO, CODEMP, STATUS,
       SUBSTR(CHAVEACESSO, 7, 14) AS CNPJ_EMIT,
       CASE WHEN DOCSREF IS NULL THEN 'N' ELSE 'S' END AS TEM_DOCSREF,
       CASE WHEN CONFIG  IS NULL THEN 'N' ELSE 'S' END AS TEM_CONFIG,
       COUNT(*) AS QTD, MIN(DHIMPORT) AS PRIMEIRA, MAX(DHIMPORT) AS ULTIMA
FROM TGFIXN
WHERE NOMEARQUIVO LIKE 'INVOICE-%'
GROUP BY CODTIPOPER, NATUREZAOPER, TIPONFE, ENTSAINFE, CFOPXML, TIPO, CODEMP, STATUS,
         SUBSTR(CHAVEACESSO, 7, 14),
         CASE WHEN DOCSREF IS NULL THEN 'N' ELSE 'S' END,
         CASE WHEN CONFIG  IS NULL THEN 'N' ELSE 'S' END
ORDER BY CODTIPOPER, CFOPXML;
```

### Amostra — 5 notas de cada TOP, com DOCSREF e CONFIG completos

Nunca incluir a coluna `XML` — inviabiliza o export.

```sql
SELECT * FROM (
  SELECT NUARQUIVO, NOMEARQUIVO, STATUS, TIPO, TIPONFE, CODEMP, CODUSUIMP,
         CODTIPOPER, NATUREZAOPER, CFOPXML, ENTSAINFE,
         NUMNOTA, SERIEDOC, VLRNOTA, DHEMISS, DHIMPORT,
         XNOMEEMIT, XNOMEDEST, CNPJDEST, CNPJPARC, CODPARC,
         SUBSTR(CHAVEACESSO, 1, 2)  AS UF_EMIT,
         SUBSTR(CHAVEACESSO, 7, 14) AS CNPJ_EMIT,
         TO_CHAR(SUBSTR(DOCSREF, 1, 1000)) AS DOCSREF_TXT,
         TO_CHAR(SUBSTR(CONFIG,  1, 1000)) AS CONFIG_TXT,
         ROW_NUMBER() OVER (PARTITION BY CODTIPOPER ORDER BY DHIMPORT DESC) AS RN
  FROM TGFIXN
  WHERE NOMEARQUIVO LIKE 'INVOICE-%'
) WHERE RN <= 5
ORDER BY CODTIPOPER, RN;
```

`TO_CHAR(SUBSTR(...))` funciona igual para CLOB e VARCHAR2 — não precisa saber o tipo.

### Acompanhamento

```sql
-- Minhas últimas gravações
SELECT * FROM (
  SELECT NUARQUIVO, NOMEARQUIVO, CHAVEACESSO, STATUS, TIPONFE, DHIMPORT, DHPROCESS,
         DETALHESIMPORTACAO
  FROM TGFIXN
  WHERE NOMEARQUIVO LIKE 'INVOICE-%' OR NOMEARQUIVO LIKE 'TESTE-%'
  ORDER BY NUARQUIVO DESC
) WHERE ROWNUM <= 10;

-- Domínio real do TIPONFE (resolve o conflito da §7)
SELECT TIPONFE, CODTIPOPER, ENTSAINFE, COUNT(*) AS QTD
FROM TGFIXN WHERE STATUS = 5
GROUP BY TIPONFE, CODTIPOPER, ENTSAINFE
ORDER BY CODTIPOPER, TIPONFE;

-- Versão vigente de uma TOP (a TGFTOP é versionada por CODTIPOPER + DHALTER)
SELECT CODTIPOPER, TO_CHAR(DHALTER,'DD/MM/YYYY HH24:MI:SS') AS DHALTER,
       DESCROPER, TIPMOV, ATUALFIN, ATUALEST, ATUALCOM
FROM TGFTOP T
WHERE CODTIPOPER IN (1234, 1766)
  AND DHALTER = (SELECT MAX(DHALTER) FROM TGFTOP WHERE CODTIPOPER = T.CODTIPOPER);
```

### Regra de ouro do DELETE

Sempre pela PK (`NUARQUIVO`), sempre rodando o SELECT com o **mesmo WHERE** antes, para
conferir que é 1 linha só. Nunca deletar por campo que repete. Confirmar com o Paulo antes,
pois ele está mexendo na base.

```sql
SELECT NUARQUIVO, NOMEARQUIVO FROM TGFIXN WHERE NUARQUIVO = 112620;
DELETE FROM TGFIXN WHERE NUARQUIVO = 112620;
```

---

## 14. Referência: a chave de acesso da NF-e

44 dígitos, posições (base 1):

| Posições | Conteúdo | Uso no script |
|---|---|---|
| 1–2 | cUF (UF do emitente) | — |
| 3–6 | AAMM da emissão | — |
| 7–20 | CNPJ do emitente | `SUBSTR(CHAVEACESSO, 7, 14)` nas queries |
| 21–22 | modelo (55 = NF-e) | — |
| 23–25 | série | → `SERIEDOC` |
| 26–34 | número da nota | → `NUMNOTA` |
| 35 | tipo de emissão | — |
| 36–43 | código numérico | — |
| 44 | dígito verificador | — |

Em JavaScript (base 0): `ch.substring(22,25)` = série, `ch.substring(25,34)` = número.

---

## 15. Tabelas Sankhya relevantes

- `TGFIXN` — importação de XML (porta de entrada; destino do robô). **Sem tabela irmã de
  itens** — o XML vai inteiro no CLOB.
- `TGFCAB` / `TGFITE` — cabeçalho e itens das notas geradas.
- `TGFPAR` — parceiros. Documento em `CGC_CPF`, **só dígitos**.
- `TGFPRO` — produtos. `TGFIPI` — enquadramento tributário.
- `TGFTOP` — tipos de operação, **versionada por `CODTIPOPER` + `DHALTER`**.
  Full: venda = **1234**, devolução = **1766**.
- `TGFTAB` / `TGFEXC` — tabelas de preço (cabeçalho com vigência / preço por produto).
- `TGFEST` — estoque. `TSIUFS` — UFs.
- `AD_TESTENOTA` — laboratório (não é produção). PK `CODNOTA`. Usada só como gatilho.
- Dicionário Oracle: `USER_TAB_COLUMNS`, `USER_CONSTRAINTS`, `USER_CONS_COLUMNS`,
  `USER_TRIGGERS`, `USER_SOURCE`, `ALL_SOURCE`, `USER_TABLES`, `USER_SCHEDULER_JOBS`.

---

## 16. Lições de método

- **Não confiar em nomes.** `AD_ESTADO` não era de estados; "Importar por Local" não é o
  motor (e é perigoso). Validar pelo dado ou pelo código.
- **Investigar em vez de adivinhar.** Sondar objetos (`for..in`), contar antes de suspeitar
  (`COUNT(*)`), comparar amostras de épocas diferentes.
- **Cuidado com viés de amostra recente.** As devoluções de agosto estavam "contaminadas"
  (subidas manualmente por causa do próprio problema). Foi preciso olhar junho para ver o
  fluxo automático saudável.
- **Gabarito de estrutura ≠ gabarito de valor.** A importação interna do Paulo revelou
  *quais* campos preencher, mas errou o *valor* de um campo digitado à mão (`TIPONFE`).
  Para valor, o gabarito é o histórico que processou com sucesso.
- **Agregar antes de amostrar.** Um `GROUP BY` sobre 121 notas eliminou 6 dúvidas de uma
  vez. Amostras individuais teriam levado muito mais rodadas.
- **Distinguir "meu código está errado" de "o ambiente está quebrado".** As notas do
  próprio Paulo também estão em STATUS 0 — prova de que o bloqueio não é nosso.
- **Testar o caminho do erro,** não só o caminho feliz.
- **Peça pequena e testável primeiro,** depois integrar.
- **Em tabela fiscal, confirmar antes de gravar ou deletar.** A `TGFIXN` não é a `AD_` de
  brincar.
