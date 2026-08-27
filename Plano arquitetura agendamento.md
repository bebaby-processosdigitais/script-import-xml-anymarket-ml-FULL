# Robô de Importação Full — Plano de Arquitetura

**Projeto:** substituir a integração Tem Api na importação de XMLs do Mercado Livre Full
**Data:** 27/08/2026
**Autor:** Dan (Processos Digitais)
**Para:** Paulo Vieira (Dev Sankhya)

---

## 1. Resumo em um parágrafo

A importação dos XMLs do Full para a `TGFIXN` já está funcionando como script JavaScript
numa ação de tela. O objetivo agora é agendá-la. Como Ações Agendadas só aceitam **Java**
ou **Proc. Banco de Dados**, o script precisa ser dividido em duas camadas. A proposta é
usar uma **tabela de fila** entre elas, com **duas Ações Agendadas independentes**: uma
Java que busca os XMLs na Anymarket e enfileira, e uma Procedure que consome a fila e
grava na `TGFIXN`. A camada Java fica com você; a Procedure fica comigo.

---

## 2. Contexto

- A Tem Api parou de trazer as notas do Full em **29/06/2026** (última `INVOICE-` em
  29/06/2026 10:59).
- Construí um robô que lê a API da Anymarket, baixa o XML e grava na `TGFIXN` com
  `STATUS = 0`, deixando o motor de importação fazer o resto.
- O robô está validado quanto a **paridade de campos**: comparei com a sua importação
  interna (NUARQUIVO 112625) e com 121 notas que a Tem Api processou com sucesso.
- Hoje ele roda como ação de tela (botão). Precisa virar agendado.

---

## 3. Por que precisa dividir em duas camadas

Ações Agendadas aceitam apenas dois tipos:

| Tipo | O que exige |
|---|---|
| **Proc. Banco de dados** | Nome de uma procedure na base |
| **Java** | Módulo Java cadastrado, com .jar implementando `ScheduledAction` (Cuckoo.jar) |

Não existe opção de agendar ação de tela em Script.

O problema é que o robô faz duas coisas de naturezas diferentes:

1. **Falar com a internet** (API da Anymarket + download do XML no S3) → precisa de Java.
   Em PL/SQL exigiria `UTL_HTTP` com ACL de rede e Oracle Wallet configurada para HTTPS.
2. **Gravar na `TGFIXN`** (regra fiscal, campos, tipos) → pode e deve ser PL/SQL.

---

## 4. Arquitetura proposta

```
┌─────────────────────────────────────────────────────────┐
│ AÇÃO AGENDADA 1 — Java — a cada 30 min                  │
│                                                          │
│  Anymarket API → pagina → filtra tipo → dedup por        │
│  IDARQUIVO → baixa XML do S3 → INSERT em AD_XMLFULL      │
└─────────────────────────────────────────────────────────┘
                          ↓
              ┌───────────────────────┐
              │   AD_XMLFULL (fila)   │
              │   STATUS = 'P'        │
              └───────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ AÇÃO AGENDADA 2 — Proc. BD — a cada 10 min              │
│                                                          │
│  STP_IMPORTA_XML_FULL: lê a fila → extrai campos do      │
│  XML → dedup por CHAVEACESSO → INSERT na TGFIXN          │
│  (STATUS 0) → atualiza a fila (I/D/E)                    │
└─────────────────────────────────────────────────────────┘
                          ↓
              ┌───────────────────────┐
              │  Motor de importação  │
              │  (suas regras do Full)│
              └───────────────────────┘
```

### Por que duas ações independentes, e não Java chamando a procedure

| Vantagem | Explicação |
|---|---|
| **Desacoplamento** | Anymarket cair não impede a Procedure de processar o que já está na fila. Bug na Procedure não impede o Java de continuar acumulando. |
| **Divisão limpa** | O Java não precisa saber nada de `TGFIXN`, campo fiscal ou regra de negócio. |
| **Reprocessamento trivial** | Erro numa nota? Volta `STATUS` para `'P'` na fila e a próxima rodada tenta de novo. Sem mexer em Java, sem rebaixar o XML. |
| **Auditoria** | A fila guarda o XML bruto recebido. Se o motor recusar, tenho o original para comparar. |
| **Autonomia** | Ajuste de campo fiscal não exige recompilar .jar. |

---

## 5. Divisão de responsabilidades

| Camada | O que faz | Quem |
|---|---|---|
| **Ação Agendada 1 (Java)** | Paginação da API, download do S3, dedup por `IDARQUIVO`, `INSERT` na fila | **Paulo** |
| **Tabela `AD_XMLFULL`** | Fila de XMLs pendentes | Dan (crio a tabela) |
| **Ação Agendada 2 (Proc)** | Extração dos campos, dedup por chave, `INSERT` na `TGFIXN`, controle de status | **Dan** |
| Script JS atual | Continua servindo como referência executável e ferramenta de teste manual | Dan |

**O que preciso de você é só a camada 1.** Ela não tem decisão de negócio nenhuma: pagina,
baixa, insere. Toda a regra fiscal fica do meu lado.

---

## 6. DDL da tabela de fila

```sql
CREATE TABLE AD_XMLFULL (
    NUFILA        NUMBER(12)     NOT NULL,   -- PK, autonumerada
    IDARQUIVO     VARCHAR2(60)   NOT NULL,   -- identificador único do documento
    TIPODOC       VARCHAR2(40)   NOT NULL,   -- 'devolution', 'sale', etc.
    SUBTIPODOC    VARCHAR2(40),              -- campo subType da API
    URLORIGEM     VARCHAR2(500),             -- URL do S3 (rastreabilidade)
    XML           CLOB           NOT NULL,   -- o XML inteiro
    DHRECEBIDO    DATE           NOT NULL,   -- quando o Java inseriu
    STATUS        VARCHAR2(1)    DEFAULT 'P' NOT NULL,
                                 -- P = pendente
                                 -- I = importado na TGFIXN
                                 -- D = duplicado (chave já existia)
                                 -- E = erro
    TENTATIVAS    NUMBER(3)      DEFAULT 0  NOT NULL,
    DHPROCESSADO  DATE,                      -- quando a Procedure tratou
    NUARQUIVO     NUMBER(12),                -- FK lógica p/ TGFIXN.NUARQUIVO
    CHAVEACESSO   VARCHAR2(44),              -- extraída pela Procedure
    MENSAGEM      VARCHAR2(500),             -- detalhe do erro, quando houver
    CONSTRAINT PK_AD_XMLFULL PRIMARY KEY (NUFILA),
    CONSTRAINT UK_AD_XMLFULL_IDARQ UNIQUE (IDARQUIVO)
);

CREATE INDEX IX_AD_XMLFULL_STATUS  ON AD_XMLFULL (STATUS, NUFILA);
CREATE INDEX IX_AD_XMLFULL_CHAVE   ON AD_XMLFULL (CHAVEACESSO);
```

### Notas sobre o desenho

**`UK_AD_XMLFULL_IDARQ`** é a rede de segurança do dedup. Mesmo que o Java falhe na
verificação, o banco recusa a duplicata. Você pode tratar a exceção como "já tenho, segue".

**`IDARQUIVO` é o nome do arquivo na URL do S3** — ver seção 8. É o único identificador
presente em 100% dos documentos.

**`TENTATIVAS`** permite dar limite a reprocessamento, evitando um XML problemático rodando
para sempre.

**`STATUS = 'D'`** (duplicado) é diferente de erro. Acontece quando a chave já existe na
`TGFIXN` — que é comportamento esperado, não falha.

**Publicação:** vou publicar a tela em Telas Adicionais para acompanhar a fila. Se preferir
outro nome ou prefixo, é só falar.

---

## 7. O que a camada Java precisa fazer

Pseudocódigo, na ordem:

```
1. Ler o token da Anymarket de um parâmetro do sistema (ANYMARKET_TOKEN)

2. Carregar em memória os IDARQUIVO já existentes:
   SELECT IDARQUIVO FROM AD_XMLFULL

3. Paginar a listagem, do offset 0 em diante:
   GET https://api.anymarket.com.br/v2/fulfillment/MERCADO_LIVRE/documents
       ?limit=50&offset={n}
   Header: gumgaToken: {token}

4. Para cada documento retornado:
   4.1 Se o "type" não está na lista habilitada → pula
   4.2 Extrair IDARQUIVO do nome do arquivo na "url"
   4.3 Se IDARQUIVO já existe em memória → pula (não baixa o XML)
   4.4 Baixar o XML da "url" — SEM o gumgaToken (é link público do S3)
   4.5 INSERT em AD_XMLFULL com STATUS = 'P'

5. Parar quando: acabar a paginação, ou atingir um limite por rodada
   (sugiro 100 inserções, para não estourar o tempo do job)
```

### Detalhes que custaram tempo para descobrir — vale reaproveitar

**O `limit` mínimo da API é 5.** Valores menores retornam HTTP 400.

**Ler o corpo da resposta mesmo em erro.** Em Java, `getInputStream()` estoura antes de ler
o corpo quando o HTTP não é 2xx. É preciso usar `getErrorStream()` — foi assim que a
mensagem sobre o limite mínimo ficou invisível por uma rodada inteira.

**O download do XML no S3 é público** — não mandar o `gumgaToken`.

**A listagem vem do mais antigo para o mais novo.** Offset 0 é o documento mais antigo da
conta. Não dá para parar cedo; é preciso percorrer.

**Não existe filtro por data.** Os únicos campos por documento são `id`, `url`,
`marketplace`, `type` e `subType`. O parâmetro `createdAfter` é aceito e repassado no link
de paginação, mas **não filtra nada** (testado: o primeiro item retornado é idêntico com e
sem o filtro). O dedup resolve melhor de qualquer forma — pega o que falta de qualquer
época, inclusive retroativo.

**O token é credencial sensível.** Um token já foi exposto e rotacionado. Ler de parâmetro
do sistema, nunca hardcoded.

### Tipos a habilitar inicialmente

```
devolution
sale_return
```

Os demais ficam para depois — ver seção 9.

---

## 8. Por que o `IDARQUIVO` é o nome do arquivo da URL

Este ponto merece explicação, porque a escolha não é óbvia.

A listagem da API retorna apenas cinco campos por documento, e **nenhum identificador
existe em todos os tipos**:

| Campo | Problema |
|---|---|
| `id` | **Ausente** nos documentos `sale` (retorna `undefined`) |
| `idOrder` | **Ausente** nos `symbolic_inbound_return` |

Sondagem de 27/08 varreu a conta inteira (1078 documentos) testando o nome do arquivo na
URL do S3 como identificador. Resultado: **0 repetidos, 0 vazios**. É único em 100% dos
casos.

```
https://s3.../transactionType-devolution/259061706.6606158899.xml
                                          └──────────┬─────────┘
                                              IDARQUIVO
```

Extração: pegar o trecho após a última `/` e remover o `.xml`. Tamanho observado: 20
caracteres (a coluna tem 60, com folga).

---

## 9. Diagnóstico: volume e parceiros por tipo

Levantamento de 27/08 (98 documentos baixados e analisados de uma conta com 1078):

| Tipo | Total na conta | Amostra | Parceiro faltando | Contraparte |
|---|---|---|---|---|
| `symbolic_inbound_return` | 522 | 25 | **0** | CNPJ |
| `sale` | 476 | — | — | — |
| `symbolic_inbound` | 32 | 25 | **0** | CNPJ |
| `devolution` | 17 | 17 | 14 | CPF |
| `inbound` | 13 | 13 | **0** | CNPJ |
| `inbound_return` | 11 | 11 | **0** | CNPJ |
| `sale_return` | 7 | 7 | 6 | CPF |

Como você confirmou que **o motor cadastra o parceiro na `TGFPAR`**, a coluna "parceiro
faltando" deixou de ser risco e passou a ser previsão de quantos serão criados.

### Ordem de habilitação pretendida

1. `devolution` + `sale_return` — já validados quanto a campos
2. Os quatro tipos de entrada e simbólicos — 100% dos parceiros já cadastrados
3. `sale` por último, e só depois de confirmar com a Denise que o Full **nunca** é faturado
   internamente. O dedup protege contra reimportar o que já passou pela `TGFIXN`, mas não
   contra alguém faturar manualmente o que o robô importou.

---

## 10. Campos gravados na `TGFIXN` (o que a Procedure faz)

Para referência. Já validado contra a sua importação interna e contra o histórico.

| Campo | Origem | Observação |
|---|---|---|
| `XML` | fila | |
| `CHAVEACESSO` | `<chNFe>` | |
| `NOMEARQUIVO` | `INVOICE-{tipo}-{IDARQUIVO}.XML` | prefixo mantido por convenção |
| `TIPO` | `'N'` | |
| `STATUS` | `0` | |
| `CODEMP` | `1` | único CNPJ emitente no Full |
| `DHIMPORT` | `SYSDATE` | |
| `CODUSUIMP` | usuário do job | irrelevante — qualquer valor processa |
| `TIPONFE` | derivado do `<tpNF>` | **ver seção 11** |
| `NUMNOTA` | chave, posições 26–34 | |
| `SERIEDOC` | chave, posições 23–25 | |
| `NATUREZAOPER` | `<natOp>` | |
| `CFOPXML` | `<CFOP>` do 1º item | |
| `ENTSAINFE` | `<tpNF>` **como String** | coluna é VARCHAR2(1) |
| `VLRNOTA` | `<vNF>` | |
| `DHEMISS` | `<dhEmi>` | |
| `DTAUTORIZACAO` | `<dhRecbto>` do protNFe | |
| `XNOMEEMIT` / `XNOMEDEST` | `<xNome>` de cada bloco | truncar em 60 |
| `CNPJDEST` | `<dest>` CNPJ ou CPF | |
| `CNPJPARC` | o lado que **não** é a BeBaby | CNPJ dela sai da chave, posições 7–20 |
| `DOCSREF` | `<docsRef><chaveAcesso>{refNFe}</chaveAcesso></docsRef>` | formato confirmado |

**Não preenchidos, de propósito:** `NUARQUIVO` (autonumerada), `CODTIPOPER` (o motor deduz
pelo modelo do XML, conforme você orientou), `CODPARC`, `CONFIG`, `NUNOTA`, `DHPROCESS`,
`CODUSUPROC`, `DETALHESIMPORTACAO`.

---

## 11. Perguntas em aberto

### 11.1 `TIPONFE` — divergência a resolver

Você me passou: **D** = Devolução, **E** = Remessa, **V** = Venda.

Levantei o histórico das notas que **processaram com sucesso** (`STATUS = 5`) e não
encontrei nenhuma com `'D'`:

| `ENTSAINFE` | `TIPONFE` | Qtd |
|---|---|---|
| 1 (saída) | `V` | 93 vendas |
| 0 (entrada) | `E` | 27 devoluções / retornos |

A correlação com o `tpNF` do XML é perfeita, sem exceção em 121 notas. Isso também explica
o `'E'` na sua importação interna (112625) — não foi descuido, foi o comportamento correto.

**Estou derivando do `tpNF`** (`0 → 'E'`, `1 → 'V'`). Existe algum caso em que o `'D'` é
usado, ou pode ficar assim?

### 11.2 O "CNPJ não encontrado"

Você disse que o motor cadastra o parceiro, e antes havia mencionado que "às vezes dá erro
de CNPJ não encontrado". Em que situação esse erro acontece? Saber isso me diz qual XML vai
falhar antes de eu tentar.

### 11.3 `NOMEARQUIVO` é apenas rótulo?

Mudei o formato de `INVOICE-{idOrder}.XML` para `INVOICE-{tipo}-{IDARQUIVO}.XML`. Mantive o
prefixo `INVOICE-` para preservar as consultas de investigação. Nada no motor depende do
formato do nome, correto?

### 11.4 Homologação

Tanto as minhas notas quanto as que **você** subiu pela importação interna (112628, 112629,
112630) seguem em `STATUS 0` com `DHPROCESS` vazio. O motor de homologação já voltou a
processar, ou as pendências de `TGFLOCOPER` e `TGFTOP->NFSETIPOPER` seguem em aberto?

Este é o único bloqueio real do projeto — sem processar, não consigo validar que a nota
nasce correta, e sem isso não habilito tipo novo.

### 11.5 Permissão de DELETE

Não consigo executar `DELETE` pelo DBExplorer. É falta de permissão no meu usuário ou a
ferramenta é somente-leitura? Pergunto porque há linhas de teste na `TGFIXN` de homologação
que em algum momento vão precisar sair (ex.: NUARQUIVO 112620, `TESTE-DHIMPORT`).

---

## 12. Fora do escopo, mas vale saber

Ao investigar o Construtor de Telas da instância `ImportacaoXMLNotas`, encontrei a ação
"Importar por Local", do tipo Rotina no Banco, que executa `STP_ALTERALOCALPADRAO_ABC`:

```sql
UPDATE TGFPRO SET CODLOCALPADRAO = PARAM_LOCAL
WHERE ATIVO = 'S' AND USALOCAL = 'S';
COMMIT;
```

O nome sugere "importar esta nota para tal local", mas ela **altera o local padrão de todos
os produtos ativos da base**, dá `COMMIT` sozinha, e **ignora** o parâmetro `P_QTDLINHAS`
(não importa quantas linhas o usuário selecionou). O `Controla Acesso` da ação está
**desligado**.

Se alguém da operação clicar achando que está direcionando uma nota, reconfigura o estoque
padrão do catálogo inteiro. Sugiro ligar o controle de acesso ou renomear a ação.

---

## 13. Próximos passos

| # | O quê | Quem | Depende de |
|---|---|---|---|
| 1 | Criar a tabela `AD_XMLFULL` e publicar a tela | Dan | — |
| 2 | Escrever `STP_IMPORTA_XML_FULL` | Dan | item 1 |
| 3 | Criar o parâmetro `ANYMARKET_TOKEN` | Dan | — |
| 4 | Módulo Java + Ação Agendada 1 | **Paulo** | itens 1 e 3 |
| 5 | Ação Agendada 2 (Proc. BD) | Dan | item 2 |
| 6 | Destravar o motor de homologação | **Paulo** | — |
| 7 | Validar uma nota processando (0 → 5) | Dan | item 6 |
| 8 | Habilitar os demais tipos | Dan | item 7 |
| 9 | Decidir processo das vendas | Dan + Denise | — |

Os itens 1, 2, 3 e 5 posso fazer em paralelo ao seu trabalho. O item 6 é o que trava a
validação — sem ele, tudo fica em `STATUS 0`.

Se preferir outra divisão, ou se a camada Java for melhor de outra forma, é só falar. O
importante é o contrato da tabela: **o Java precisa gravar `IDARQUIVO`, `TIPODOC`,
`SUBTIPODOC`, `URLORIGEM`, `XML`, `DHRECEBIDO` e `STATUS = 'P'`**. O resto é meu.
