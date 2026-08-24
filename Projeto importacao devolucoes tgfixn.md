# Projeto: Robô de Importação de Devoluções Full (Anymarket → Sankhya TGFIXN)

> **Propósito deste documento:** handoff de contexto para continuar o projeto em uma
> nova conversa, sem precisar reexplicar tudo. Contém o objetivo, o estado atual,
> as descobertas da investigação, o código funcionando e os pontos em aberto.
>
> **Última atualização:** 21/08/2026

---

## 1. Contexto do negócio

- **Empresa:** BeBaby Group Importação Ltda. (distribuidora das marcas Kikkaboo e ABC Design).
- **ERP:** Sankhya (Oracle como SGBD).
- **Objetivo do projeto:** reduzir dependência da integração terceirizada **Tem Api**,
  começando por reconstruir de forma independente a importação das **notas de devolução
  do Mercado Livre Full** para dentro do Sankhya.
- **Problema que originou tudo:** a integração (Tem Api) **parou de trazer as notas do
  Full em ~29/06/2026** (data confirmada por investigação — ver seção 5). Desde então
  notas de venda e devolução do Full não estão mais "caindo" no Sankhya automaticamente.
- **Fonte de dados escolhida:** API da **Anymarket** (já temos acesso e token).
  Evolução futura possível: ir direto na API do Mercado Livre (elimina intermediário).

---

## 2. Pessoas / papéis

- **Usuário (Dan):** conduzindo o desenvolvimento, aprendendo Sankhya no processo.
- **Paulo Vieira:** dev terceirizado do Sankhya. Configurou as "regras do Full" no motor
  de importação. É a autoridade sobre o comportamento do motor e a estrutura fiscal.
- **Denise:** stakeholder de operações (é para ela que o processo precisa fazer sentido).

---

## 3. Arquitetura da solução (decidida)

O fluxo final do robô é:

```
Anymarket API  →  baixa XML da devolução  →  grava na TGFIXN  →  motor do Sankhya processa sozinho
```

**Descoberta-chave:** NÃO é preciso extrair dados do XML manualmente nem cadastrar parceiro.
O **motor de importação do Sankhya faz tudo isso** quando você grava o XML na tabela
**`TGFIXN`** (a "porta de entrada" fiscal do Portal de Importação de XML). O Paulo confirmou:
*"Se você importar o XML, ele faz o resto, com as regras que já criei pro Full."*

A tabela intermediária de aprendizado `AD_TESTENOTA` (ver seção 8) foi um **laboratório**
para aprender os mecanismos — não é o caminho de produção. O caminho de produção é gravar
direto na `TGFIXN`.

---

## 4. A tabela TGFIXN (porta de entrada da importação)

- **PK:** `NUARQUIVO` (autonumerada — NÃO setar, o Sankhya gera no `save()`).
- **Campo do XML:** `XML` (tipo CLOB — recebe o XML inteiro).
- **NÃO tem trigger de banco** (confirmado: `USER_TRIGGERS` da TGFIXN veio vazio).
- **O motor de processamento é código Java** (caixa-preta, não acessível por SQL).
  Provado por eliminação: sem trigger, e nenhuma procedure PL/SQL contém a lógica de
  transformar XML em nota (as únicas procedures que mencionam TGFIXN são de saída/sincronização:
  `TRG_INC_TGFCAB`, `TRG_UPD_TGFCAB`, `TRG_DLT_TGFCAB`, `STP_GERAR_LIVRO_FIN`).

### Campos de entrada confirmados (o que gravar no INSERT)

| Campo | Valor | Origem da confirmação |
|---|---|---|
| `XML` | o XML inteiro | obrigatório, é o principal |
| `CHAVEACESSO` | os 44 dígitos da NF-e | extraído do XML |
| `STATUS` | `0` (pendente, p/ processar) | exemplo do Paulo |
| `CODEMP` | `1` | dados de produção |
| `TIPO` | `'N'` (NF-e) | exemplo do Paulo |
| `NOMEARQUIVO` | `INVOICE-{idOrder}.XML` | padrão que a Tem Api usava |
| `DHIMPORT` | `new Date()` | **confirmado necessário pelo Paulo**; testado e funciona |

### Campos que NÃO se seta

- `NUARQUIVO` — PK autonumerada.
- `CODTIPOPER` (a TOP) — o Paulo disse *"passa sem"*: o motor deduz a TOP do próprio XML.

### Campos ainda EM DÚVIDA (a confirmar quando a base voltar / com o Paulo)

- `TIPONFE` — nas notas de VENDA processadas aparece `'V'`. Nas devoluções pode ser outro
  valor. **Não copiar cegamente o 'V' da venda.**
- `CODUSUIMP` — "usuário de importação". Nas notas boas aparece `102`. Provavelmente deve
  ser o usuário da sessão, não o 102 literal.
- **Estratégia:** quando a base voltar e uma nota tentar processar, o campo
  `DETALHESIMPORTACAO` mostrará qualquer erro / campo faltante. É mais preciso que adivinhar.

---

## 5. Blueprint da integração original (reconstruído por engenharia reversa em PROD)

Investigação forense na TGFIXN de produção revelou como a Tem Api fazia (o que replicar):

- **Nome do arquivo:** `INVOICE-{idOrder}.XML` (o idOrder bate com o da Anymarket).
- **Vendas:** `CODTIPOPER` (TOP) = **1234**, natureza "Venda de mercadorias", CFOP 5106/6106.
- **Devoluções:** `CODTIPOPER` (TOP) = **1766**, natureza "Devolucao de mercadorias" OU
  "Retorno de mercadoria nao entregue", CFOP variado (ex.: 1202).
- **Emitente (`XNOMEEMIT`):** BEBABY GROUP IMPORTACAO LTDA.
- **Destinatário (`XNOMEDEST`):** o consumidor final (pessoa física).
- **`CODEMP`:** 1 (mas atenção: em PROD há notas com CODEMP 1 e 2 — a BeBaby tem +de uma
  empresa; validar qual usar por caso).
- **`STATUS` final:** 5 (processada com sucesso).
- **`IMPORTADOMDE`:** vazio (as INVOICE- NÃO vêm do DF-e; as que vêm do DF-e têm 'S' e
  `NOMEARQUIVO` = "ARQUIVO BAIXADO PELO DF-E").
- **Data em que parou:** a última nota `INVOICE-` em PROD é de **29/06/2026 10:59**.

**Nota importante sobre amostragem:** as devoluções recentes (agosto) em PROD estavam
"contaminadas" — subidas manualmente via DF-e por causa do próprio problema. Foi preciso
olhar **junho** (antes da quebra) para ver o fluxo automático saudável. Lição: cuidado com
viés de amostra recente.

**Débito técnico / a validar com contador e Paulo:**
- Confirmar que as devoluções da Anymarket são realmente todas do Full (assumido pelo
  endpoint ter `/fulfillment/` no path, mas não provado no dado).
- Tratamento fiscal correto (TOP, CFOP, chave referenciada da venda original) — decisão
  fiscal, não técnica. O motor com "regras do Full" do Paulo já cobre isso ao processar.

---

## 6. A API da Anymarket

### Endpoint de listagem de documentos (com paginação)

```
GET https://api.anymarket.com.br/v2/fulfillment/MERCADO_LIVRE/documents?limit=50&offset=0
Header: gumgaToken: {TOKEN}
```

- Retorna JSON com `content` (lista de documentos) e `links` (com `rel:"next"` p/ paginação).
- Cada documento tem: `idOrder`, `url` (link do XML no S3), `marketplace`, `type`.
- **Tipos observados na conta:** `symbolic_inbound_return` (502), `sale` (423),
  `inbound` (19), `symbolic_inbound` (28), `inbound_return` (11), **`devolution` (12)**,
  **`sale_return` (5)**.
- **Os tipos que interessam (viram devolução, TOP 1766):** `devolution` E `sale_return`.
- As devoluções são RARAS e ficam espalhadas — precisa varrer várias páginas (não estão
  na primeira). O robô usa `MAX_PAGINAS = 30`.

### Download do XML

- A `url` de cada documento aponta para o S3 da Amazon (link público).
- **Baixa SEM o gumgaToken** (é público; mandar token pode atrapalhar).

### SEGURANÇA — token

- O `gumgaToken` é credencial sensível. **Nunca colar em chat/log.**
- Um token foi exposto em conversa e foi (ou deve ser) **rotacionado**. Usar sempre o token
  novo/válido, de preferência via parâmetro do sistema (`getParametroSistema`) em produção,
  não hardcoded no script.

---

## 7. Convenções de script Sankhya (versão desta instalação) — MUITO IMPORTANTE

Aprendidas na marra; valem para qualquer script de ação nesta base:

- **Mensagem ao usuário (sucesso):** `mensagem = "texto";`
  → NÃO cancela a transação (a gravação persiste). Caixa fica AMARELA ("Informação").
- **Mensagem de erro / abortar:** `throw "texto";`
  → CANCELA a transação (rollback — desfaz `save()` anteriores!). Caixa VERMELHA ("Erro").
  → **Lição dolorosa:** usar `throw` depois de gravar APAGA a gravação. Use `mensagem =` para sucesso.
- **Ler campo da linha selecionada:** `linhas[0].getCampo('NOMECAMPO')`
- **Gravar campo:** `linha.setCampo('CAMPO', valor)` + `linha.save()`
- **Criar registro novo:** `var nova = novaLinha('NOMETABELA'); nova.setCampo(...); nova.save();`
  → PK autonumerada é gerada sozinha (não setar).
- **Consultar o banco (SELECT):**
  ```javascript
  var q = getQuery("native");
  q.setParam("x", valor);
  q.nativeSelect("SELECT ... WHERE campo = {x}");   // placeholder é {x}, não ?
  if (q.next()) { var v = q.getString("COLUNA"); }
  ```
- **Chamada HTTP externa (ponte Java):** `new java.net.URL(...)`, `openConnection()`,
  `setRequestProperty(...)`, ler com `java.util.Scanner(...).useDelimiter("\\A")`.
- **Data atual:** `new Date()` (funciona no setCampo; testado com DHIMPORT).
- **Investigar objeto desconhecido:** `for (var k in obj) { ... }` lista métodos/props.
  Métodos úteis descobertos: `contexto, linhas, linhaPai, getQuery, novaLinha,
  getUsuarioLogado, mensagem, mostraErro, getParam, confirmarSimNao, email`.

### Erros comuns de sintaxe

- **`unterminated string literal`** → aspa não fechada, geralmente aspas "curvas" vindas de
  copiar/colar, ou `\n` quebrando a string. Evitar `\n`; usar aspas retas.
- **`"X is not defined"`** → variável usada sem `var` antes. Declarar no topo.

---

## 8. Ambiente de aprendizado: AD_TESTENOTA (laboratório)

Tabela adicional criada do zero como laboratório (NÃO é produção). Serviu para aprender
todo o mecanismo antes de partir para a TGFIXN. Estrutura:

- PK autonumerada: `CODNOTA`
- Campos: `CHAVEACESSO` (texto), `DOCPARC` (texto, doc do parceiro), `NOMEPARC` (texto),
  `CODPARC` (inteiro, código interno do parceiro), `PARCEXISTE` (S/N), `TIPONOTA` (texto),
  `STATUS` (texto), `DTIMPORT` (data/hora).
- Tela publicada em Menu do Sistema → Telas Adicionais → pasta "Testes" (tipo "Tela adicional").
- Tem uma ação Script chamada **"Verificar Parceiro"** (o botão do raio ⚡) — é nela que os
  scripts de teste são colados e executados.

**Importante:** o botão da AD_TESTENOTA é usado como "gatilho" para rodar os scripts,
mas os scripts atuais gravam na TGFIXN, não na AD_TESTENOTA.

### Query de dedup de parceiro validada (blindada contra NULL)

Descoberta importante: comparar CGC_CPF exige blindagem, senão parceiros sem documento
"vazam" no resultado (string vazia = NULL no Oracle).

```sql
SELECT CODPARC, NOMEPARC FROM TGFPAR
WHERE CGC_CPF IS NOT NULL
AND REGEXP_REPLACE(CGC_CPF, '[^0-9]', '') = '{documento_so_digitos}'
```

Na base, o `CGC_CPF` é armazenado **só com dígitos** (sem máscara).

---

## 9. CÓDIGO ATUAL — Robô que grava UMA devolução nova na TGFIXN

Este é o script funcional atual (colado na ação "Verificar Parceiro" da AD_TESTENOTA).
Ele: varre páginas da Anymarket → acha a 1ª devolução NOVA (não duplicada) → baixa o XML →
grava na TGFIXN. **Troca `cole_o_token_NOVO` pelo token real.**

```javascript
var token = "cole_o_token_NOVO";

function baixa(endereco, comToken) {
    var url = new java.net.URL(endereco);
    var conn = url.openConnection();
    if (comToken) conn.setRequestProperty("gumgaToken", token);
    conn.setConnectTimeout(15000);
    var sc = new java.util.Scanner(conn.getInputStream(), "UTF-8").useDelimiter("\\A");
    var txt = sc.hasNext() ? sc.next() : "";
    sc.close();
    return String(txt);
}
function extrai(texto, tag) {
    var abre = "<" + tag + ">", fecha = "</" + tag + ">";
    var ini = texto.indexOf(abre);
    if (ini < 0) return null;
    ini += abre.length;
    var fim = texto.indexOf(fecha, ini);
    return (fim < 0) ? null : texto.substring(ini, fim);
}

var offset = 0, limit = 50, paginas = 0, MAX_PAGINAS = 30;
var alvo = null;
var chaveAlvo = null;

while (paginas < MAX_PAGINAS && alvo == null) {
    var dados = JSON.parse(baixa("https://api.anymarket.com.br/v2/fulfillment/MERCADO_LIVRE/documents?limit=" + limit + "&offset=" + offset, true));
    var lista = dados.content;
    if (lista == null || lista.length === 0) break;

    for (var i = 0; i < lista.length; i++) {
        var t = lista[i].type;
        if (t === "devolution" || t === "sale_return") {
            var xmlTmp = baixa(lista[i].url, false);
            var ch = extrai(xmlTmp, "chNFe");
            var dup = getQuery("native");
            dup.setParam("chave", ch);
            dup.nativeSelect("SELECT COUNT(*) AS QTD FROM TGFIXN WHERE CHAVEACESSO = {chave}");
            dup.next();
            if (Number(dup.getString("QTD")) === 0) {
                alvo = lista[i];
                chaveAlvo = ch;
                break;
            }
        }
    }

    var temNext = false;
    if (dados.links != null) {
        for (var j = 0; j < dados.links.length; j++) {
            if (dados.links[j].rel === "next") temNext = true;
        }
    }
    if (!temNext) break;
    offset += limit;
    paginas++;
}

if (alvo == null) {
    throw "Nenhuma devolucao NOVA encontrada (todas ja estao na TGFIXN, ou nao ha nenhuma).";
}

var xml = baixa(alvo.url, false);
var idOrder = alvo.idOrder;

var nova = novaLinha('TGFIXN');
nova.setCampo('XML', xml);
nova.setCampo('CHAVEACESSO', chaveAlvo);
nova.setCampo('STATUS', 0);
nova.setCampo('CODEMP', 1);
nova.setCampo('TIPO', 'N');
nova.setCampo('NOMEARQUIVO', 'INVOICE-' + idOrder + '.XML');
nova.setCampo('DHIMPORT', new Date());
nova.save();

mensagem = "Gravado na TGFIXN! Tipo: " + alvo.type + " | Chave: " + chaveAlvo + " | idOrder: " + idOrder;
```

### Extração de dados do XML (referência — o motor faz isso, mas útil p/ diagnóstico)

- Chave de acesso: `extrai(xml, "chNFe")` (44 dígitos).
- Bloco emitente: `extrai(xml, "emit")` → dentro: `CNPJ`/`CPF`, `xNome`.
- Bloco destinatário: `extrai(xml, "dest")` → dentro: `CNPJ`/`CPF`, `xNome`.
  (Na devolução: emitente = BEBABY; destinatário = consumidor final.)
- CFOP: `extrai(xml, "CFOP")`; Natureza: `extrai(xml, "natOp")`.

---

## 10. ESTADO ATUAL / BLOQUEIO

- ✅ Robô de coleta funcionando (Anymarket → filtra devolution/sale_return → baixa XML → dedup).
- ✅ Gravação na TGFIXN funcionando (com todos os campos conhecidos + DHIMPORT).
- ✅ Já existem ~5 notas de teste gravadas na TGFIXN de homologação, em STATUS 0
  (NUARQUIVO ex.: 112616, 112617, 112618, 112619, 112621; + uma linha fake `TESTE-DHIMPORT`
  NUARQUIVO 112620).
- ⛔ **BLOQUEIO ATUAL:** a **base de teste (homologação) está com erro de estrutura** e o
  Portal de Importação de XML não carrega. Erros:
  - "A tabela **`TGFLOCOPER`** não existe no banco de dados" (Cabeçalho de Nota, Parceiro)
  - "Metadados do campo **`TGFTOP->NFSETIPOPER`** não inicializados" (ImportacaoXMLNotas)
  - Causa provável: base clonada e versão da aplicação **dessincronizadas** (falta rodar
    update de estrutura, ou reclonar). **É problema de INFRA, não de código.**
  - **Paulo está tratando disso.** Por isso as notas ficam em STATUS 0 — o motor não roda.

O ambiente de homologação é um **clone periódico da produção** (isolado — seguro para testar,
gravar aqui NÃO gera nota fiscal real).

---

## 11. PRÓXIMOS PASSOS (quando a base voltar)

1. **Paulo confirmar** que a base foi consertada (TGFLOCOPER / NFSETIPOPER resolvidos).
2. Pegar UMA das notas em STATUS 0 (ou gravar uma nova) e **observar se processa** (0 → 5).
3. **Se travar:** ler o campo `DETALHESIMPORTACAO` — ele diz exatamente o que falta.
4. Confirmar os campos em dúvida (`TIPONFE`, `CODUSUIMP`) — pelo erro do motor ou com o Paulo.
5. **Validar a nota gerada:** CODTIPOPER virou 1766? Parceiro certo? Valor bate? NUNOTA gerado?
6. Opcional: usar **Monitoramento de Banco de Dados** para ver o motor em ação (os SQLs que
   ele dispara ao processar) — forma de entender o mecanismo sem acessar o código Java.
7. Evoluir do "1 nota" para **processamento em lote** (todas as devoluções novas, com o
   `MAX_PAGINAS` e um `LIMITE` por rodada para não estourar timeout de ação de tela).
8. Migração final para **robô agendado** (não uma ação de botão) — provavelmente via
   API Gateway / job, para rodar sozinho. Aí sim substitui de fato a Tem Api.

---

## 12. Queries úteis de investigação (SELECT, seguras)

```sql
-- Estrutura de uma tabela (troca o nome)
SELECT COLUMN_ID, COLUMN_NAME, DATA_TYPE, DATA_LENGTH, NULLABLE
FROM USER_TAB_COLUMNS WHERE TABLE_NAME = 'TGFIXN' ORDER BY COLUMN_ID;

-- PK de uma tabela
SELECT cols.COLUMN_NAME, cols.POSITION
FROM USER_CONSTRAINTS cons
JOIN USER_CONS_COLUMNS cols ON cons.CONSTRAINT_NAME = cols.CONSTRAINT_NAME
WHERE cons.TABLE_NAME = 'TGFIXN' AND cons.CONSTRAINT_TYPE = 'P' ORDER BY cols.POSITION;

-- Achar coluna por nome parcial
SELECT COLUMN_NAME FROM USER_TAB_COLUMNS
WHERE TABLE_NAME = 'TGFIXN' AND COLUMN_NAME LIKE '%DH%';

-- Minhas últimas gravações na TGFIXN (por NUARQUIVO, pega até as sem DHIMPORT)
SELECT * FROM (
  SELECT NUARQUIVO, NOMEARQUIVO, CHAVEACESSO, STATUS, DHIMPORT, DETALHESIMPORTACAO
  FROM TGFIXN
  WHERE NOMEARQUIVO LIKE 'INVOICE-%' OR NOMEARQUIVO LIKE 'TESTE-%'
  ORDER BY NUARQUIVO DESC
) WHERE ROWNUM <= 10;

-- Devoluções que processaram com sucesso (gabarito, TOP 1766)
SELECT NUARQUIVO, STATUS, TIPO, TIPONFE, CODUSUIMP, CODTIPOPER, NATUREZAOPER, DHIMPORT, NOMEARQUIVO
FROM TGFIXN WHERE STATUS = 5 AND CODTIPOPER = 1766 ORDER BY DHIMPORT DESC;
```

### Regra de ouro do DELETE
Sempre pela PK (`NUARQUIVO`), sempre rodando o SELECT com o mesmo WHERE ANTES para conferir
que é 1 linha só. Nunca deletar por campo que repete (ex.: STATUS). Confirmar com o Paulo
antes, pois ele está mexendo na base.

```sql
-- 1) confere
SELECT NUARQUIVO, NOMEARQUIVO FROM TGFIXN WHERE NUARQUIVO = 112620;
-- 2) só então (com o mesmo WHERE)
DELETE FROM TGFIXN WHERE NUARQUIVO = 112620;
```

---

## 13. Tabelas Sankhya relevantes (referência rápida)

- `TGFIXN` — importação de XML de notas (a porta de entrada; destino do robô).
- `TGFCAB` / `TGFITE` — cabeçalho e itens das notas geradas.
- `TGFPAR` — parceiros (clientes/fornecedores). Doc em `CGC_CPF` (só dígitos).
- `TGFPRO` — produtos. `TGFIPI` — enquadramento tributário (IPI etc.).
- `TGFTOP` — tipos de operação (TOP). `TGFEST` — estoque. `TSIUFS` — UFs (CODUF/UF).
- `TGFTOP` da devolução Full = **1766**; da venda Full = **1234**.
- `USER_TAB_COLUMNS`, `USER_CONSTRAINTS`, `USER_TRIGGERS`, `USER_SOURCE`, `ALL_SOURCE`,
  `USER_SCHEDULER_JOBS` — dicionário Oracle para investigação.

---

## 14. Lições de método (que guiaram o projeto)

- **Não confiar em nomes** (de tabela, coluna, ação) — validar pelo dado/código real.
  (Ex.: `AD_ESTADO` não era de estados; "Importar por Local" não é o motor.)
- **Investigar em vez de adivinhar:** sondar objetos (`for..in`), contar antes de suspeitar
  (`COUNT(*)`), comparar amostras de épocas diferentes (viés da amostra recente).
- **Testar o caminho do erro**, não só o caminho feliz (foi assim que se achou o bug do NULL).
- **Peça pequena e testável primeiro**, depois integrar.
- **Distinguir "meu código está errado" de "o ambiente está quebrado"** (ex.: TGFLOCOPER).
- Em tabela fiscal (TGFIXN), **confirmar antes de gravar/deletar** — não é a AD_ de brincar.
```
